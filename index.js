const { getChannels, pay, signMessage, getChainBalance, getPendingChannels, openChannel, getNode, addPeer, getPeers } = require('ln-service')
const lnurlClient = require('./clients/lnurl')
const bitfinexClient = require('./clients/bitfinex')

const axios = require('axios')
const config = require('./config.json')
const { lnd } = require('./lnd')
const PATHFINDING_TIMEOUT_MS = config.PATHFINDING_TIMEOUT_MS || 60 * 1000 // 1 minute
const DEEZY_PUBKEY = '024bfaf0cabe7f874fd33ebf7c6f4e5385971fc504ef3f492432e9e3ec77e1b5cf'
const CHAIN_BALANCE_BUFFER = 50000

async function tryPayInvoice({ invoice, paymentAmountSats, maxRouteFeePpm, outChannelIds }) {
    const maxRouteFeeSats = Math.floor(maxRouteFeePpm * paymentAmountSats / 1000000)
    console.log(`Using max route fee sats ${maxRouteFeeSats}`)

    // Sometimes LND hangs too long when trying to pay, and we need to kill the process.
    function abortMission() {
        console.error("Payment timeout exceeded without terminating. Exiting!")
        process.exit(1)
    }

    const paymentTimeout = setTimeout(abortMission, PATHFINDING_TIMEOUT_MS * 2)
    const paymentResult = await pay(
        {
            lnd,
            request: invoice,
            outgoing_channels: outChannelIds,
            max_fee: maxRouteFeeSats,
            pathfinding_timeout: PATHFINDING_TIMEOUT_MS,
        }
    ).catch(err => {
        console.error(err)
        console.log(`Failed to pay invoice ${invoice}`)
        return null
    })
    clearTimeout(paymentTimeout)

    if (!paymentResult || !paymentResult.confirmed_at) return

    const feePpm = Math.round(paymentResult.safe_fee * 1000000 / paymentAmountSats)
    console.log(`Payment confirmed, with fee ${paymentResult.safe_fee} satoshis, and ppm ${feePpm}`)
}

async function attemptPaymentToDestination({ destination, outChannelIds }) {
    let invoice
    const paymentAmountSats = destination.PAYMENT_AMOUNT_SATS
    switch (destination.TYPE) {
        case 'LNURL':
            invoice = await lnurlClient.fetchInvoice({
                lnUrlOrAddress: destination.LNURL_OR_ADDRESS,
                paymentAmountSats
            })
            break;
        case 'BITFINEX':
            invoice = await bitfinexClient.fetchInvoice({ 
                paymentAmountSats,
                apiSecret: destination.API_SECRET,
                apiKey: destination.API_KEY 
            })
            break;
        default:
            console.error(`Unknown type ${destination.type}`)
            return
    }
    if (!invoice) {
        console.log('no invoice returned')
        return
    }

    await tryPayInvoice({
        invoice,
        paymentAmountSats,
        maxRouteFeePpm: destination.MAX_ROUTE_FEE_PPM,
        outChannelIds
    }).catch(err => {
        console.error(err)
    })
}

function isReadyToEarnAndClose({ channel }) {
    return channel.local_balance * 1.0 / channel.capacity < (1 - config.CLOSE_WHEN_CHANNEL_EXCEEDS_RATIO)
}

async function earnAndClose({ channel }) {
    const channelPoint = `${channel.transaction_id}:${channel.transaction_vout}`
    console.log(`Requesting earn and close for deezy channel: ${channelPoint}`)
    const message = `close ${channelPoint}`
    const { signature } = await signMessage({ lnd, message }).catch(err => {
        console.error(err)
        return {}
    })
    if (!signature) return
    const body = {
        channel_point: channelPoint,
        signature
    }
    const response = await axios.post(`https://api.deezy.io/v1/earn/closechannel`, body).catch(err => {
        console.error(err)
        return {}
    })
    console.log(response.data)
}

async function maybeOpenChannel({ localInitiatedDeezyChannels }) {
    const currentLocalSats = localInitiatedDeezyChannels.reduce((acc, it) => acc + it.local_balance, 0)
    const { pending_channels } = await getPendingChannels({ lnd })
    const pendingOpenLocalSats = pending_channels.reduce((acc, it) => acc + it.local_balance, 0)

    const totalLocalSats = currentLocalSats + pendingOpenLocalSats
    console.log(`Total local open or pending sats: ${totalLocalSats}`)
    if (totalLocalSats > (config.OPEN_CHANNEL_WHEN_LOCAL_SATS_BELOW || 0)) {
        console.log(`Not opening channel, total local sats ${totalLocalSats} is above threshold ${config.OPEN_CHANNEL_WHEN_LOCAL_SATS_BELOW}`)
        return
    }

    const chainBalance = (await getChainBalance({ lnd })).chain_balance
    console.log(`Chain balance is ${chainBalance}`)

    if (chainBalance < config.DEEZY_CHANNEL_SIZE_SATS + CHAIN_BALANCE_BUFFER) {
        console.log(`Not opening channel, chain balance ${chainBalance} is below threshold ${config.DEEZY_CHANNEL_SIZE_SATS} plus buffer ${CHAIN_BALANCE_BUFFER}`)
        return
    }

    console.log(`Opening channel with ${DEEZY_PUBKEY} for ${config.DEEZY_CHANNEL_SIZE_SATS} sats`)
    const { transaction_id, transaction_vout } = await openChannel({
        lnd,
        local_tokens: config.DEEZY_CHANNEL_SIZE_SATS,
        partner_public_key: DEEZY_PUBKEY
    }).catch(err => {
        console.error(err)
        return {}
    })
    if (!transaction_id || !transaction_vout) return false
    console.log(`Initiated channel with deezy, txid ${transaction_id}, vout ${transaction_vout}`)
    return true
}

async function ensureConnectedToDeezy() {
    const { peers } = await getPeers({ lnd })
    const deezyPeer = peers.find(it => it.public_key === DEEZY_PUBKEY)
    if (deezyPeer) {
        console.log(`Already connected to deezy`)
        return
    }
    console.log(`Connecting to deezy`)
    const deezyNodeInfo = await getNode({ lnd, is_omitting_channels: true, public_key: DEEZY_PUBKEY })
    await addPeer({ lnd, public_key: DEEZY_PUBKEY, socket: deezyNodeInfo.sockets[0].socket }).catch(err => {
        console.error(err)
    })
}

async function maybeAutoWithdraw({ destination }) {
    if (destination.type !== 'BITFINEX') {
        console.log(`AUTO_WITHDRAW is currently only enabled for BITFINEX destinations`)
        return
    }
    await bitfinexClient.maybeAutoWithdraw({ 
        apiKey, 
        apiSecret, 
        address: destination.ON_CHAIN_WITHDRAWAL_ADDRESS,
        minWithdrawalSats: destination.ON_CHAIN_WITHDRAWAL_TARGET_SIZE_SATS
    })
}

async function run() {
    await ensureConnectedToDeezy()
    console.log(`Fetching channel info`)
    const { channels } = await getChannels({
        lnd,
        partner_public_key: DEEZY_PUBKEY
    }).catch(err => {
        console.error(err)
        return {}
    })
    if (!channels) return
    const localInitiatedDeezyChannels = channels.filter(it => !it.is_partner_initiated)
    console.log(`Found ${localInitiatedDeezyChannels.length} locally initiated channel(s) with deezy`)

    console.log(`Checking if any deezy channels are ready to close`)
    for (const channel of localInitiatedDeezyChannels) {
        if (isReadyToEarnAndClose({ channel })) {
            await earnAndClose({ channel })
            // Terminate here if we are closing a channel.
            console.log(`Attempted to earn and close channel, terminating here.`)
            return
        }
    }

    console.log(`Checking if we should open a channel to deezy`)
    await maybeOpenChannel({ localInitiatedDeezyChannels })

    const outChannelIds = localInitiatedDeezyChannels.map(it => it.id)
    if (outChannelIds.length === 0) {
        console.log(`No locally initiated channels to deezy currently open, terminating here`)
        return
    }

    for (const destination of config.DESTINATIONS) {
        await attemptPaymentToDestination({ destination, outChannelIds }).catch(err => {
            console.error(err)
        })
        if (destination.AUTO_WITHDRAW) {
            await maybeAutoWithdraw({ destination }).catch(err => {
                console.error(err)
            })
        }
    }
}

run()