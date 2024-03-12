import { createDebug } from '@nichoth/debug'
import { IDBPCursorWithValue, IDBPDatabase, openDB } from 'idb'
const debug = createDebug()

const VERSION = 1

debug('version', VERSION)

// export class IndexedStore {
// }

export interface AnyAction {
    [extra:string]:any
    type:string
}

export type ID = string

export interface MetaData {
    /**
     * Sequence number of action in current log. Log fills it.
     */
    seq:number

    /**
     * Action unique ID. Log sets it automatically.
     */
    id:ID

    /**
     * Why action should be kept in the log.
     * Actions without reasons will be removed.
     */
    reasons:string[]

    /**
     * Set code as reason and remove this reasons from previous actions.
     */
    subprotocol?:string

    /**
     * Action created time in current node time. Milliseconds since UNIX epoch.
     */
    time:number
}

/**
 * Compare the time when two log entries were created.
 *
 * It uses `meta.time` and `meta.id` to detect entries order.
 *
 * @example
 * ```js
 * import { isFirstOlder } from '@bicycle-codes/partylog-client'
 * if (isFirstOlder(lastBeep, nextBeep)) {
 *   beep(action)
 *   lastBeep = meta
 * }
 * ```
 *
 * @param firstMeta Some action’s metadata.
 * @param secondMeta Other action’s metadata.
 */
export function isFirstOlder (
    firstMeta:Partial<MetaData>|string,
    secondMeta:Partial<MetaData>|string
):boolean {
    if (typeof firstMeta === 'string') {
        firstMeta = { id: firstMeta, time: parseInt(firstMeta) }
    }
    if (typeof secondMeta === 'string') {
        secondMeta = { id: secondMeta, time: parseInt(secondMeta) }
    }

    if (firstMeta.time! > secondMeta.time!) {
        return false
    } else if (firstMeta.time! < secondMeta.time!) {
        return true
    }

    const firstID = firstMeta.id!.split(' ')
    const secondID = secondMeta.id!.split(' ')

    const firstNode = firstID[1]
    const secondNode = secondID[1]
    if (firstNode > secondNode) {
        return false
    } else if (firstNode < secondNode) {
        return true
    }

    const firstCounter = parseInt(firstID[2])
    const secondCounter = parseInt(secondID[2])
    if (firstCounter > secondCounter) {
        return false
    } else if (firstCounter < secondCounter) {
        return true
    }

    const firstNodeTime = parseInt(firstID[0])
    const secondNodeTime = parseInt(secondID[0])
    if (firstNodeTime > secondNodeTime) {
        return false
    } else if (firstNodeTime < secondNodeTime) {
        return true
    }

    return false
}

/**
 * Take an IDB open request; transform it into a promise.
 *
 * @param {IDBOpenDBRequest} request Request to open the DB
 * @returns {Promise<IDBOpenDBRequest['result']>}
 */
function promisify (
    request:IDBOpenDBRequest
):Promise<IDBOpenDBRequest['result']> {
    return new Promise((resolve, reject) => {
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
            resolve(request.result)
        }
    })
}

export class IndexedStore {
    name:string
    adding:Record<string, boolean>
    db:Promise<IDBPDatabase>

    constructor (name = 'logux') {
        this.name = name
        this.adding = {}
        this.db = openDB(this.name, VERSION)
            .then(async db => {
                db.onversionchange = () => {
                    db.close()
                    if (window.location.reload) window.location.reload()
                }

                const log = (await this.db).createObjectStore('log', {
                    autoIncrement: true,
                    keyPath: 'added'
                })
                log.createIndex('id', 'id', { unique: true })
                log.createIndex('created', 'created', { unique: true })
                log.createIndex('reasons', 'reasons', { multiEntry: true });
                (await this.db).createObjectStore('extra', { keyPath: 'key' })

                return db
            })
    }

    async os (name:string, write?:'write'|boolean) {
        const mode = write ? 'readwrite' : 'readonly'
        return (await this.db).transaction(name, mode).objectStore(name)
    }

    // init () {

    //     // const store = this
    //     // const opening = indexedDB.open(this.name, VERSION)

    //     // /**
    //     //  * @see https://developer.mozilla.org/en-US/docs/Web/API/IDBOpenDBRequest#example
    //     //  */
    //     // opening.onupgradeneeded = (ev) => {
    //     //     const db = (ev.target!).result as IDBDatabase

    //     //     let log
    //     //     if (ev.oldVersion < 1) {
    //     //         log = db.createObjectStore('log', {
    //     //             autoIncrement: true,
    //     //             keyPath: 'added'
    //     //         })
    //     //         log.createIndex('id', 'id', { unique: true })
    //     //         log.createIndex('created', 'created', { unique: true })
    //     //         log.createIndex('reasons', 'reasons', { multiEntry: true })
    //     //         db.createObjectStore('extra', { keyPath: 'key' })
    //     //     }

    //     //     if (ev.oldVersion < 1) {
    //     //         if (!log) {
    //     //             log = opening.transaction!.objectStore('log')
    //     //         }
    //     //         log.createIndex('indexes', 'indexes', { multiEntry: true })
    //     //     }
    //     // }

    //     // const db = await openDB();

    //     // this.initing = promisify(opening).then(db => {
    //     //     this.db = db
    //     //     db.onversionchange = () => {
    //     //         this.db?.close()
    //     //         if (window.location.reload) {
    //     //             window.location.reload()
    //     //         }
    //     //     }

    //     //     return true
    //     // })

    //     // this.initing = promisify(opening).then(db => {
    //     //     store.db = db
    //     //     db.onversionchange = function () {
    //     //         store.db.close()
    //     //         if (typeof document !== 'undefined' && document.reload) {
    //     //             document.reload()
    //     //         }
    //     //     }
    //     //     return store
    //     // })

    //     // return this.initing
    // }

    // add(action: AnyAction, meta: Meta): Promise<false | Meta>

    /**
     * Add an action to `IndexedDB`.
     * @param {AnyAction} action
     * @param {MetaData} meta
     * @returns {Promise<false|MetaData>}
     */
    async add (action:AnyAction, meta:MetaData):Promise<false|MetaData> {
        const id = meta.id.split(' ')
        const entry = {
            action,
            created: [meta.time, id[1], id[2], id[0]].join(' '),
            id: meta.id,
            meta,
            reasons: meta.reasons,
            time: meta.time
        }

        if (this.adding[entry.created]) {
            return false
        }
        this.adding[entry.created] = true

        const exist = await (await this.os('log')).index('id').get(meta.id)
        if (exist) {
            return false
        } else {
            const added = await (await this.os('log', 'write')).add!(entry)
            delete this.adding[entry.created]
            meta.seq = typeof added === 'string' ? parseInt(added) : added as number
            return meta
        }
    }

    async byId (id:string) {
        const result = await (await this.os('log')).index('id').get(id)
        if (result) return [result.action, result.meta]
        return [null, null]
    }

    async changeMeta (id:string, diff:Partial<MetaData>):Promise<boolean> {
        const entry = await (await this.os('log')).index('id').get(id)
        if (!entry) return false

        for (const key in diff) entry.meta[key] = diff[key]
        if (diff.reasons) entry.reasons = diff.reasons;
        (await this.os('log', 'write')).put!(entry)
        return true
    }

    async clean ():Promise<IDBOpenDBRequest> {
        (await this.db).close()
        return indexedDB.deleteDatabase(this.name)
    }

    async get ({ index, order }:{ index:string; order?:'created' }):Promise<void> {
        const log = await this.os('log')

        let request
        if (index) {
            if (order === 'created') {
                request = log.index('created')
            } else {
                const keyRange = IDBKeyRange.only(index)
                request = log.index('indexes').openCursor(keyRange, 'prev')
            }
        } else if (order === 'created') {
            request = log.index('created').openCursor(null, 'prev')
        } else {
            request = log.openCursor(null, 'prev')
        }

        request.onerror = (err) => { throw err }

        type entry = [AnyAction, MetaData]
        const entries:entry[] = []
        request.onsuccess = (ev) => {
            const cursor = ev.target.result
            if (!cursor) return entries
            if (!index || cursor.value.indexes.includes(index)) {
                cursor.value.meta.added = cursor.value.added
                entries.unshift([cursor.value.action, cursor.value.meta])
            }
            cursor.continue()
        }
    }

    /**
     * Get the last added `seq` number of action.
     * @returns {number}
     */
    async getLastAdded () {
        const cursor = await (await this.os('log')).openCursor(null, 'prev')
        return cursor ? cursor.value.added : 0
    }

    /**
     * Get { received, sent } numbers for last synced
     * @returns {Promise<{ received:number, sent:number }>}
     */
    async getLastSynced () {
        const data:{
            received,
            sent
        } = await (await this.os('extra')).get('lastSynced')

        if (data) {
            return { received: data.received, sent: data.sent }
        } else {
            return { received: 0, sent: 0 }
        }
    }

    async remove (id:string) {
        const entry:{
            added,
            action,
            meta
        } = await (await this.os('log')).index('id').get('id')
        if (!entry) return false;

        (await this.os('log', 'write')).delete!(entry.added)
        entry.meta.added = entry.added
        return [entry.action, entry.meta]
    }

    async removeReason (reason, criteria, callback) {
        const store = await this.init()
        if (criteria.id) {
            const entry = await promisify(store.os('log').index('id').get(criteria.id))
            if (entry) {
                const index = entry.meta.reasons.indexOf(reason)
                if (index !== -1) {
                    entry.meta.reasons.splice(index, 1)
                    entry.reasons = entry.meta.reasons
                    if (entry.meta.reasons.length === 0) {
                        callback(entry.action, entry.meta)
                        await promisify(store.os('log', 'write').delete(entry.added))
                    } else {
                        await promisify(store.os('log', 'write').put(entry))
                    }
                }
            }
        } else {
            await new Promise((resolve, reject) => {
                const log = store.os('log', 'write')
                const request = log.index('reasons').openCursor(reason)
                rejectify(request, reject)
                request.onsuccess = function (e) {
                    if (!e.target.result) {
                        resolve()
                        return
                    }

                    const entry = e.target.result.value
                    const m = entry.meta
                    const c = criteria

                    if (isDefined(c.olderThan) && !isFirstOlder(m, c.olderThan)) {
                        e.target.result.continue()
                        return
                    }
                    if (isDefined(c.youngerThan) && !isFirstOlder(c.youngerThan, m)) {
                        e.target.result.continue()
                        return
                    }
                    if (isDefined(c.minAdded) && entry.added < c.minAdded) {
                        e.target.result.continue()
                        return
                    }
                    if (isDefined(c.maxAdded) && entry.added > c.maxAdded) {
                        e.target.result.continue()
                        return
                    }

                    let process
                    if (entry.reasons.length === 1) {
                        entry.meta.reasons = []
                        entry.meta.added = entry.added
                        callback(entry.action, entry.meta)
                        process = log.delete(entry.added)
                    } else {
                        entry.reasons.splice(entry.reasons.indexOf(reason), 1)
                        entry.meta.reasons = entry.reasons
                        process = log.put(entry)
                    }

                    rejectify(process, reject)
                    process.onsuccess = function () {
                        e.target.result.continue()
                    }
                }
            })
        }
    }

    async setLastSynced (values) {
        const store = await this.init()
        let data = await promisify(store.os('extra').get('lastSynced'))
        if (!data) data = { key: 'lastSynced', received: 0, sent: 0 }
        if (typeof values.sent !== 'undefined') {
            data.sent = values.sent
        }
        if (typeof values.received !== 'undefined') {
            data.received = values.received
        }
        await promisify(store.os('extra', 'write').put(data))
    }
}

function isDefined (value) {
    return typeof value !== 'undefined'
}

function rejectify (request, reject) {
    request.onerror = e => {
        reject(e.target.error)
    }
}
