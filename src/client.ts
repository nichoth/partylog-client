import {
    ClientNode,
    isFirstOlder,
    Log,
    MemoryStore,
    parseId,
    Reconnect,
    WsConnection
} from '@logux/core'
import { createNanoEvents } from 'nanoevents'
import { nanoid } from 'nanoid'
import { LoguxUndoError } from '../logux-undo-error/index.js'
import { track } from '../track/index.js'

const ALLOWED_META = ['id', 'time', 'subprotocol']

function tabPing (c) {
    localStorage.setItem(c.options.prefix + ':tab:' + c.tabId, Date.now())
}

function cleanTabActions (client, id) {
    client.log.removeReason('tab' + id).then(() => {
        if (client.isLocalStorage) {
            localStorage.removeItem(client.options.prefix + ':tab:' + id)
        }
    })
}

function isEqual (obj1, obj2) {
    if (!obj1 && !obj2) return true
    return JSON.stringify(obj1) === JSON.stringify(obj2)
}

function unsubscribeChannel (client, unsubscribe) {
    const json = JSON.stringify({ ...unsubscribe, type: 'logux/subscribe' })
    const subscribers = client.subscriptions[json]
    if (subscribers) {
        if (subscribers === 1) {
            delete client.subscriptions[json]
        } else {
            client.subscriptions[json] = subscribers - 1
        }
    }
}

export class Client {
    constructor (opts = {}) {
        this.options = opts

        if (process.env.NODE_ENV !== 'production') {
            if (typeof this.options.server === 'undefined') {
                throw new Error('Missed server option in Logux client')
            }
            if (typeof this.options.subprotocol === 'undefined') {
                throw new Error('Missed subprotocol option in Logux client')
            }
            if (typeof this.options.userId === 'undefined') {
                throw new Error(
                    'Missed userId option in Logux client. ' +
            'Pass false if you have no users.'
                )
            }
            if (this.options.userId === false) {
                throw new Error('Replace userId: false to userId: "false"')
            }
            if (typeof this.options.userId !== 'string') {
                throw new Error('userId must be a string')
            }
            if (this.options.userId.includes(':')) {
                throw new Error('userId can’t contain colon character')
            }
        }

        if (typeof this.options.prefix === 'undefined') {
            this.options.prefix = 'logux'
        }

        this.isLocalStorage = false
        if (typeof localStorage !== 'undefined') {
            const random = nanoid()
            try {
                localStorage.setItem(random, '1')
                localStorage.removeItem(random)
                this.isLocalStorage = true
            } catch {}
        }

        if (!this.options.time) {
            this.clientId = this.options.userId + ':' + this.getClientId()
            this.tabId = nanoid(8)
        } else {
            this.tabId = this.options.time.lastId + 1 + ''
            this.clientId = this.options.userId + ':' + this.tabId
        }

        this.nodeId = this.clientId + ':' + this.tabId
        const store = this.options.store || new MemoryStore()

        let log
        if (this.options.time) {
            log = this.options.time.nextLog({ nodeId: this.nodeId, store })
        } else {
            log = new Log({ nodeId: this.nodeId, store })
        }
        this.log = log

        this.last = {}
        this.subscriptions = {}
        const subscribing = {}
        const unsubscribing = {}

        log.on('preadd', (action, meta) => {
            if (parseId(meta.id).nodeId === this.nodeId && !meta.subprotocol) {
                meta.subprotocol = this.options.subprotocol
            }

            if (action.type === 'logux/unsubscribe') {
                let wasSubscribed = true
                let processedOffline = false

                for (const id in subscribing) {
                    const subscribe = subscribing[id]
                    if (subscribe.channel === action.channel) {
                        if (isEqual(action.filer, subscribe.filter)) {
                            wasSubscribed = false
                            delete subscribing[id]
                            log.changeMeta(id, { reasons: [] })
                            break
                        }
                    }
                }

                if (wasSubscribed && this.state === 'disconnected') {
                    processedOffline = true
                    unsubscribeChannel(this, action)
                }
                if (wasSubscribed && !processedOffline) {
                    meta.sync = true
                } else {
                    delete meta.sync
                }
            }

            if (meta.sync && !meta.resubscribe) meta.reasons.push('syncing')
        })

        this.emitter = createNanoEvents()
        this.on('add', (action, meta) => {
            const type = action.type
            let last
            if (type === 'logux/processed' || type === 'logux/undo') {
                this.log.removeReason('syncing', { id: action.id })
            }
            if (type === 'logux/subscribe' && !meta.resubscribe) {
                subscribing[meta.id] = action
            } else if (type === 'logux/unsubscribe') {
                if (meta.sync) unsubscribing[meta.id] = action
            } else if (type === 'logux/processed') {
                if (unsubscribing[action.id]) {
                    unsubscribeChannel(this, unsubscribing[action.id])
                } else if (subscribing[action.id]) {
                    const subscription = subscribing[action.id]
                    delete subscribing[action.id]
                    const json = JSON.stringify(subscription)
                    if (this.subscriptions[json]) {
                        this.subscriptions[json] += 1
                    } else {
                        this.subscriptions[json] = 1
                    }
                    last = this.last[subscription.channel]
                    if (!last || isFirstOlder(last, meta)) {
                        this.last[subscription.channel] = { id: meta.id, time: meta.time }
                    }
                }
                if (this.processing[action.id]) {
                    this.processing[action.id][1](meta)
                    delete this.processing[action.id]
                }
            } else if (type === 'logux/undo') {
                if (this.processing[action.id]) {
                    this.processing[action.id][2](new LoguxUndoError(action))
                    delete this.processing[action.id]
                }
                delete subscribing[action.id]
                delete unsubscribing[action.id]
            } else if (meta.channels) {
                if (!meta.id.includes(' ' + this.clientId + ':')) {
                    meta.channels.forEach(channel => {
                        last = this.last[channel]
                        if (!last || isFirstOlder(last, meta)) {
                            this.last[channel] = { id: meta.id, time: meta.time }
                        }
                    })
                }
            }
        })

        this.tabPing = 60000
        this.tabTimeout = 10 * this.tabPing
        const reason = 'tab' + this.tabId
        if (this.isLocalStorage) {
            const unbind = log.on('add', (action, meta) => {
                if (meta.reasons.includes(reason)) {
                    tabPing(this)
                    this.pinging = setInterval(() => {
                        tabPing(this)
                    }, this.tabPing)
                    unbind()
                }
            })
        }

        let connection
        if (typeof this.options.server === 'string') {
            const ws = new WsConnection(this.options.server)
            connection = new Reconnect(ws, {
                attempts: this.options.attempts,
                maxDelay: this.options.maxDelay,
                minDelay: this.options.minDelay
            })
        } else {
            connection = this.options.server
        }

        const onSend = async (action, meta) => {
            if (!!meta.sync && parseId(meta.id).userId === this.options.userId) {
                const filtered = {}
                for (const i in meta) {
                    if (i === 'subprotocol') {
                        if (meta.subprotocol !== this.options.subprotocol) {
                            filtered.subprotocol = meta.subprotocol
                        }
                    } else if (ALLOWED_META.includes(i)) {
                        filtered[i] = meta[i]
                    }
                }
                return [action, filtered]
            } else {
                return false
            }
        }

        this.node = new ClientNode(this.nodeId, this.log, connection, {
            fixTime: !this.options.time,
            onSend,
            ping: this.options.ping,
            subprotocol: this.options.subprotocol,
            timeout: this.options.timeout,
            token: this.options.token
        })

        if (/^ws:\/\//.test(this.options.server) && !opts.allowDangerousProtocol) {
            const unbindEnvTest = this.node.on('state', () => {
                if (this.node.state === 'synchronized') {
                    unbindEnvTest()
                    if (this.node.remoteHeaders.env !== 'development') {
                        console.error(
                            'Without SSL, old proxies block WebSockets. ' +
                'Use WSS for Logux or set allowDangerousProtocol option.'
                        )
                        this.destroy()
                    }
                }
            })
        }

        this.node.on('debug', (type, stack) => {
            if (type === 'error') {
                console.error('Error on Logux server:\n', stack)
            }
        })

        let disconnected = true
        this.node.on('state', () => {
            const state = this.node.state
            if (state === 'synchronized') {
                if (disconnected) {
                    disconnected = false
                    for (const i in this.subscriptions) {
                        const action = JSON.parse(i)
                        const since = this.last[action.channel]
                        if (since) action.since = since
                        this.log.add(action, { resubscribe: true, sync: true })
                    }
                }
            } else if (this.node.state === 'disconnected') {
                disconnected = true
            }
        })

        this.onUnload = this.onUnload.bind(this)
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('unload', this.onUnload)
        }

        this.processing = {}
    }

    changeUser (userId, token) {
        if (process.env.NODE_ENV !== 'production') {
            if (typeof userId !== 'string') {
                throw new Error('userId must be a string')
            }
            if (userId.includes(':')) {
                throw new Error('userId can’t contain colon character')
            }
        }

        const wasConnected = this.node.connected
        if (wasConnected) this.node.connection.disconnect('destroy')

        this.options.userId = userId
        this.options.token = token
        this.clientId = userId + ':' + this.getClientId()
        this.nodeId = this.clientId + ':' + this.tabId

        this.log.nodeId = this.nodeId
        this.node.localNodeId = this.nodeId
        this.node.options.token = token

        this.emitter.emit('user', userId)
        if (wasConnected) this.node.connection.connect()
    }

    clean () {
        this.destroy()
        return this.log.store.clean ? this.log.store.clean() : Promise.resolve()
    }

    cleanPrevActions () {
        if (!this.isLocalStorage) return

        for (const i in localStorage) {
            const prefix = this.options.prefix + ':tab:'
            if (i.slice(0, prefix.length) === prefix) {
                const time = parseInt(localStorage.getItem(i))
                if (Date.now() - time > this.tabTimeout) {
                    cleanTabActions(this, i.slice(prefix.length))
                }
            }
        }
    }

    destroy () {
        this.onUnload()
        this.node.destroy()
        clearInterval(this.pinging)
        if (typeof window !== 'undefined' && window.removeEventListener) {
            window.removeEventListener('unload', this.onUnload)
        }
    }

    getClientId () {
        return nanoid(8)
    }

    on (event, listener) {
        if (event === 'state') {
            return this.node.emitter.on(event, listener)
        } else if (event === 'user') {
            return this.emitter.on(event, listener)
        } else {
            return this.log.emitter.on(event, listener)
        }
    }

    onUnload () {
        if (this.pinging) cleanTabActions(this, this.tabId)
    }

    start (connect = true) {
        this.cleanPrevActions()
        if (connect) this.node.connection.connect()
    }

    sync (action, meta = {}) {
        meta.sync = true
        if (typeof meta.id === 'undefined') {
            meta.id = this.log.generateId()
        }

        this.log.add(action, meta)
        return track(this, meta.id)
    }

    type (type, listener, opts) {
        if (typeof type === 'function') type = type.type
        return this.log.type(type, listener, opts)
    }

    waitFor (state) {
        if (this.state === state) {
            return Promise.resolve()
        }
        return new Promise(resolve => {
            const unbind = this.on('state', () => {
                if (this.state === state) {
                    unbind()
                    resolve()
                }
            })
        })
    }

    get connected () {
        return this.state !== 'disconnected' && this.state !== 'connecting'
    }

    get state () {
        return this.node.state
    }
}
