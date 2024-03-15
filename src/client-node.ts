import { BaseNode } from '../base-node/index.js'

const DEFAULT_OPTIONS = {
    fixTime: true,
    ping: 10000,
    timeout: 70000
}

/**
 * Clients have a reference to a `Log`.
 */

export class ClientNode {
    remoteNodeId?:string
    remoteProtocol = undefined
    remoteSubprotocol = undefined

    minProtocol = 3
    localProtocol = 4
    localNodeId = nodeId

    log = log
    connection = connection
    options = options

    constructor (nodeId, log, connection, options = {}) {
        super(nodeId, log, connection, {
            ...options,
            fixTime: options.fixTime ?? DEFAULT_OPTIONS.fixTime,
            ping: options.ping ?? DEFAULT_OPTIONS.ping,
            timeout: options.timeout ?? DEFAULT_OPTIONS.timeout
        })
    }

    onConnect () {
        if (!this.connected) {
            this.connected = true
            this.initializing = this.initializing.then(() => {
                if (this.connected) this.sendConnect()
            })
        }
    }
}

export class BaseNode {
    constructor (nodeId, log, connection, options = {}) {
        this.remoteNodeId = undefined
        this.remoteProtocol = undefined
        this.remoteSubprotocol = undefined

        this.minProtocol = 3
        this.localProtocol = 4
        this.localNodeId = nodeId

        this.log = log
        this.connection = connection
        this.options = options

        if (this.options.ping && !this.options.timeout) {
            throw new Error('You must set timeout option to use ping')
        }

        this.connected = false
        this.authenticated = false
        this.unauthenticated = []

        this.timeFix = 0
        this.syncing = 0
        this.received = {}

        this.lastSent = 0
        this.lastReceived = 0

        this.state = 'disconnected'

        this.emitter = createNanoEvents()
        this.timeouts = []
        this.throwsError = true

        this.unbind = [
            log.on('add', (action, meta) => {
                this.onAdd(action, meta)
            }),
            connection.on('connecting', () => {
                this.onConnecting()
            }),
            connection.on('connect', () => {
                this.onConnect()
            }),
            connection.on('message', message => {
                this.onMessage(message)
            }),
            connection.on('error', error => {
                if (error.message === 'Wrong message format') {
                    this.sendError(new LoguxError('wrong-format', error.received))
                    this.connection.disconnect('error')
                } else {
                    this.error(error)
                }
            }),
            connection.on('disconnect', () => {
                this.onDisconnect()
            })
        ]

        this.initialized = false
        this.lastAddedCache = 0
        this.initializing = this.initialize()
        this.localHeaders = {}
        this.remoteHeaders = {}
    }

    catch (listener) {
        this.throwsError = false
        const unbind = this.on('error', listener)
        return () => {
            this.throwsError = true
            unbind()
        }
    }

    delayPing () {
        if (!this.options.ping) return
        if (this.pingTimeout) clearTimeout(this.pingTimeout)

        this.pingTimeout = setTimeout(() => {
            if (this.connected && this.authenticated) this.sendPing()
        }, this.options.ping)
    }

    destroy () {
        if (this.connection.destroy) {
            this.connection.destroy()
        } else if (this.connected) {
            this.connection.disconnect('destroy')
        }
        for (const i of this.unbind) i()
        clearTimeout(this.pingTimeout)
        this.endTimeout()
    }

    duilianMessage (line) {
        if (DUILIANS[line]) {
            this.send(['duilian', DUILIANS[line]])
        }
    }

    endTimeout () {
        if (this.timeouts.length > 0) {
            clearTimeout(this.timeouts.shift())
        }
    }

    error (err) {
        this.emitter.emit('error', err)
        this.connection.disconnect('error')
        if (this.throwsError) {
            throw err
        }
    }

    async initialize () {
        const [synced, added] = await Promise.all([
            this.log.store.getLastSynced(),
            this.log.store.getLastAdded()
        ])
        this.initialized = true
        this.lastSent = synced.sent
        this.lastReceived = synced.received
        this.lastAddedCache = added
        if (this.connection.connected) this.onConnect()
    }

    now () {
        return Date.now()
    }

    on (event, listener) {
        return this.emitter.on(event, listener)
    }

    async onAdd (action, meta) {
        if (!this.authenticated) return
        if (this.lastAddedCache < meta.added) {
            this.lastAddedCache = meta.added
        }

        if (this.received && this.received[meta.id]) {
            delete this.received[meta.id]
            return
        }

        if (this.options.outFilter) {
            try {
                const result = await this.options.outFilter(action, meta)
                if (result) syncMappedEvent(this, action, meta)
            } catch (e) {
                this.error(e)
            }
        } else {
            syncMappedEvent(this, action, meta)
        }
    }

    onConnect () {
        this.delayPing()
        this.connected = true
    }

    onConnecting () {
        this.setState('connecting')
    }

    onDisconnect () {
        while (this.timeouts.length > 0) {
            this.endTimeout()
        }
        if (this.pingTimeout) clearTimeout(this.pingTimeout)
        this.authenticated = false
        this.connected = false
        this.syncing = 0
        this.setState('disconnected')
    }

    onMessage (msg) {
        this.delayPing()
        const name = msg[0]

        if (!this.authenticated && !BEFORE_AUTH.includes(name)) {
            this.unauthenticated.push(msg)
            return
        }

        this[name + 'Message'](...msg.slice(1))
    }

    send (msg) {
        if (!this.connected) return
        this.delayPing()
        try {
            this.connection.send(msg)
        } catch (e) {
            this.error(e)
        }
    }

    sendDuilian () {
        this.send(['duilian', Object.keys(DUILIANS)[0]])
    }

    setLastReceived (value) {
        if (this.lastReceived < value) this.lastReceived = value
        this.log.store.setLastSynced({ received: value })
    }

    setLastSent (value) {
        if (this.lastSent < value) {
            this.lastSent = value
            this.log.store.setLastSynced({ sent: value })
        }
    }

    setLocalHeaders (headers) {
        this.localHeaders = headers
        if (this.connected) {
            this.sendHeaders(headers)
        }
    }

    setState (state) {
        if (this.state !== state) {
            this.state = state
            this.emitter.emit('state')
        }
    }

    startTimeout () {
        if (!this.options.timeout) return

        const ms = this.options.timeout
        const timeout = setTimeout(() => {
            if (this.connected) this.connection.disconnect('timeout')
            this.syncError('timeout', ms)
        }, ms)

        this.timeouts.push(timeout)
    }

    syncError (type, options, received) {
        const err = new LoguxError(type, options, received)
        this.emitter.emit('error', err)
        if (!NOT_TO_THROW[type] && this.throwsError) {
            throw err
        }
    }

    async syncSince (lastSynced) {
        const data = await this.syncSinceQuery(lastSynced)
        if (!this.connected) return
        if (data.entries.length > 0) {
            if (this.options.outMap) {
                Promise.all(
                    data.entries.map(i => {
                        return this.options.outMap(i[0], i[1])
                    })
                )
                    .then(changed => {
                        this.sendSync(data.added, changed)
                    })
                    .catch(e => {
                        this.error(e)
                    })
            } else {
                this.sendSync(data.added, data.entries)
            }
        } else {
            this.setState('synchronized')
        }
    }

    async syncSinceQuery (lastSynced) {
        const promises = []
        await this.log.each({ order: 'added' }, (action, meta) => {
            if (meta.added <= lastSynced) return false
            if (this.options.outFilter) {
                promises.push(
                    this.options
                        .outFilter(action, meta)
                        .then(r => {
                            if (r) {
                                return [action, meta]
                            } else {
                                return false
                            }
                        })
                        .catch(e => {
                            this.error(e)
                        })
                )
            } else {
                promises.push(Promise.resolve([action, meta]))
            }
            return true
        })

        const entries = await Promise.all(promises)

        const data = { added: 0 }
        data.entries = entries.filter(entry => {
            if (entry && data.added < entry[1].added) {
                data.added = entry[1].added
            }
            return entry !== false
        })
        return data
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
}