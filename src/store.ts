import { createDebug } from '@nichoth/debug'
import { toString } from 'uint8arrays'
import stringify from 'json-canon'
import { blake3 } from '@noble/hashes/blake3'
import ts from 'monotonic-timestamp'
const debug = createDebug()

const VERSION = 1

debug('version', VERSION)

export interface Action {
    /**
     * Action type name.
     */
    type: string
}

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

export interface LogPage {
    /**
     * Pagination page.
     */
    entries:[Action, MetaData][]

    /**
     * Next page loader.
     */
    next?():Promise<LogPage>
}

export interface ReadonlyListener<
    ListenerAction extends Action,
    LogMeta extends MetaData
> {
    (action:ListenerAction, meta:LogMeta):void
}

export interface Criteria {
    /**
     * Remove reason only for action with `id`.
     */
    id?:ID

    /**
     * Remove reason only for actions with lower `added`.
     */
    maxAdded?:number

    /**
     * Remove reason only for actions with bigger `added`.
     */
    minAdded?:number

    /**
     * Remove reason only older than specific action.
     */
    olderThan?:MetaData

    /**
     * Remove reason only younger than specific action.
     */
    youngerThan?:MetaData
}

export interface Entry {
    seq:number;
    action:AnyAction;
    created:string;
    id:string;
    meta:MetaData;
    reasons:string[];
    time:number;
}

export class IndexedStore {
    readonly name:string
    readonly adding:Record<string, boolean>
    readonly db:Promise<IDBDatabase>

    constructor (name = 'logparty') {
        this.name = name
        this.adding = {}

        this.db = new Promise((resolve, reject) => {
            const req = indexedDB.open(this.name, VERSION)
            req.onerror = err => reject(err)

            req.onsuccess = () => resolve(req.result)

            req.onupgradeneeded = function (ev) {
                const db = req.result

                let log:IDBObjectStore
                if (ev.oldVersion < 1) {
                    log = db.createObjectStore('log', {
                        autoIncrement: true,
                        keyPath: 'seq'
                    })
                    log.createIndex('id', 'id', { unique: true })
                    log.createIndex('created', 'created', { unique: true })
                    log.createIndex('reasons', 'reasons', { multiEntry: true })
                    db.createObjectStore('extra', { keyPath: 'key' })
                }
                if (ev.oldVersion < 2) {
                    if (!log!) {
                        log = req.transaction!.objectStore('log')
                    }
                    log.createIndex('indexes', 'indexes', { multiEntry: true })
                }
            }
        })
    }

    /**
     * Get a new objectstore
     *
     * @param {'log'|'extra'} name Object store name, 'log' | 'extra'
     * @param write Writable or read only?
     * @returns {Promise<IDBObjectStore>}
     */
    async os (name:'log'|'extra', write?:'write'):Promise<IDBObjectStore> {
        const mode = write ? 'readwrite' : 'readonly'
        return (await this.db).transaction(name, mode).objectStore(name)
    }

    /**
     * Add an action to `IndexedDB`. Valid `MetaData` will be created.
     *
     * ID is just the hash of the metadata.
     *
     * @param {AnyAction} action
     * @param {MetaData} meta
     * @returns {Promise<false|MetaData>} Return false if the add operation
     * failed, eg b/c the given ID already exists. Return `MetaData` otherwise.
     */
    async add (
        action:AnyAction,
        meta:Partial<MetaData> = {}
    ):Promise<MetaData|null> {
        const seq = (await this.getLastAdded() + 1)
        const created = ts()

        const newEntryData = {
            seq,
            action,
            created,
            meta,
            reasons: meta.reasons,
            time: created
        }

        const newID = toString(blake3(stringify(newEntryData)), 'base64urlpad')

        // could have `subprotocol` on the passed in metadata
        const newMetadata:MetaData = {
            ...meta,
            seq,
            id: newID,
            reasons: meta.reasons || [],
            time: created
        }

        const entry:Entry = {
            action,
            created,
            meta: newMetadata,
            seq,
            reasons: newMetadata.reasons,
            time: created,
            id: newID,
        }

        if (this.adding[entry.created]) {
            return null
        }
        this.adding[entry.created] = true

        const exist = await promisify(
            (await this.os('log')).index('id').get(newMetadata.id)
        )

        if (exist) return null

        await (await this.os('log', 'write')).add(entry)
        delete this.adding[entry.created]
        return newMetadata
    }

    /**
     * Get an action by ID
     * @param {string} id The ID
     * @returns {Promise<[AnyAction, MetaData]|[null, null]>}
     */
    async byId (id:string):Promise<[AnyAction, MetaData]|[null, null]> {
        const result = await promisify<{
            action,
            meta
        }>((await this.os('log')).index('id').get(id))

        if (result) return [result.action, result.meta]
        return [null, null]
    }

    /**
     * Update the metadata of the given ID.
     *
     * @param {string} id The ID to update
     * @param {Partial<MetaData>} diff The updates
     * @returns {Promise<boolean>} True if update was successful, false if the
     * given ID was not found.
     */
    async changeMeta (id:string, diff:Partial<MetaData>):Promise<boolean> {
        const entry = await promisify<Entry>(
            (await this.os('log')).index('id').get(id)
        )
        if (!entry) return false

        for (const key in diff) entry.meta[key] = diff[key]
        if (diff.reasons) entry.reasons = diff.reasons;
        (await this.os('log', 'write')).put(entry)
        return true
    }

    /**
     * Delete this database.
     * @returns {Promise<void>}
     */
    async clean () {
        (await this.db).close()
        indexedDB.deleteDatabase(this.name)
    }

    /**
     * Return a Promise with the first page. Page object has `entries` property
     * with part of results and `next` property with a function to load the
     * next page. If it was the last page, `next` property should be empty.
     *
     * We need a pagination API because the log could be very big.
     *
     * @param {{ index, order }} opts Query options.
     * @returns Promise with first page.
     */
    async get ({ index, order }:{
        index:string;
        order?:'created'
    }):Promise<LogPage> {
        return new Promise((resolve, reject) => {
            this.os('log').then(log => {
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

                request.onerror = (err) => { reject(err) }

                // type entry = [AnyAction, MetaData]
                type entry = [AnyAction, MetaData]
                const entries:entry[] = []
                // const entries:Entry[] = []
                request.onsuccess = (ev) => {
                    const cursor = ev.target.result
                    if (!cursor) return resolve({ entries })
                    if (!index || cursor.value.indexes.includes(index)) {
                        cursor.value.meta.added = cursor.value.added
                        entries.unshift([cursor.value.action, cursor.value.meta])
                    }
                    cursor.continue()
                }
            })
        })
    }

    /**
     * Get the last added `seq` number of action.
     * @returns {Promise<number>}
     */
    async getLastAdded ():Promise<number> {
        const cursor = await promisify<IDBCursorWithValue>(
            (await this.os('log')).openCursor(null, 'prev')
        )

        return cursor ? cursor.value.seq : 0
    }

    /**
     * Get { received, sent } numbers for last synced
     * @returns {Promise<{ received:number, sent:number }>}
     */
    async getLastSynced ():Promise<{ received:number, sent:number }> {
        const data:{
            received,
            sent
        } = await promisify<{ received, sent }>(
            (await this.os('extra')).get('lastSynced')
        )

        if (data) {
            return { received: data.received, sent: data.sent }
        } else {
            return { received: 0, sent: 0 }
        }
    }

    async remove (id:string) {
        const entry = await promisify<Entry>(
            (await this.os('log')).index('id').get(id)
        )
        if (!entry) return false;

        (await this.os('log', 'write')).delete(entry.seq)
        entry.meta.seq = entry.seq
        return [entry.action, entry.meta]
    }

    async removeReason (
        reason:string,
        criteria:Criteria,
        cb:ReadonlyListener<Action, MetaData>
    ):Promise<void> {
        if (criteria.id) {
            const entry = await promisify<Entry>(
                (await this.os('log')).index('id').get(criteria.id)
            )

            if (entry) {
                const index = entry.meta.reasons.indexOf(reason)
                if (index !== -1) {
                    entry.meta.reasons.splice(index, 1)
                    entry.reasons = entry.meta.reasons
                    if (entry.meta.reasons.length === 0) {
                        cb(entry.action, entry.meta)
                        await (await this.os('log', 'write')).delete!(entry.seq)
                    } else {
                        await (await this.os('log', 'write')).put!(entry)
                    }
                }
            }
        } else {
            const log = await this.os('log', 'write')
            const request = log.index('reasons').openCursor(reason)
            await new Promise((resolve, reject) => {
                request.onsuccess = (ev) => {
                    // @ts-expect-error Why TS failing?
                    if (!ev.target!.result) return resolve()
                    const entry = request.result!.value
                    const m = entry.meta
                    const c = criteria

                    if (isDefined(c.olderThan) && !isFirstOlder(m, c.olderThan!)) {
                        request.result?.continue()
                    }
                    if (
                        isDefined(c.youngerThan) &&
                        !isFirstOlder(c.youngerThan!, m)
                    ) {
                        request.result?.continue()
                        return
                    }
                    if (isDefined(c.minAdded) && entry.added < c.minAdded!) {
                        request.result?.continue()
                        return
                    }
                    if (isDefined(c.maxAdded) && entry.added > c.maxAdded!) {
                        request.result?.continue()
                    }

                    entry.reasons = entry.reasons.filter(i => i !== reason)
                    entry.meta.reasons = entry.reasons

                    let process:IDBRequest
                    if (entry.reasons.length === 0) {
                        entry.meta.added = entry.added
                        cb(entry.action, entry.meta)
                        process = log.delete(entry.added)
                    } else {
                        process = log.put(entry)
                    }

                    process.onerror = err => reject(err)
                    process.onsuccess = () => process.result.continue()
                }
            })
        }
    }

    async setLastSynced (values:Partial<{ sent:number, received:number }>) {
        let data:{
            key:'lastSynced',
            received:number,
            sent:number
        } = await promisify((await this.os('extra')).get('lastSynced'))

        if (!data) data = { key: 'lastSynced', received: 0, sent: 0 }
        if (typeof values.sent !== 'undefined') {
            data.sent = values.sent
        }
        if (typeof values.received !== 'undefined') {
            data.received = values.received
        }

        (await this.os('extra', 'write')).put(data)
    }
}

function isDefined (value:any) {
    return typeof value !== 'undefined'
}

function rejectify (request, reject) {
    request.onerror = e => {
        reject(e.target.error)
    }
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
 * @param {Partial<MetaData>} firstMeta Some action’s metadata.
 * @param {Partial<MetaData>} secondMeta Other action’s metadata.
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

function promisify<T> (request:IDBRequest) {
    return new Promise<T>((resolve, reject) => {
        rejectify(request, reject)
        request.onsuccess = () => {
            resolve(request.result)
        }
    })
}
