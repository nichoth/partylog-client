import { createDebug } from '@nichoth/debug'
import { toString } from 'uint8arrays'
import {
    openDB,
    IDBPDatabase,
    deleteDB,
    DBSchema,
    IDBPCursorWithValue
} from '@bicycle-codes/idb'
import stringify from 'json-canon'
import { blake3 } from '@noble/hashes/blake3'
import ts from 'monotonic-timestamp'
import { createDeviceName } from '@bicycle-codes/identity'
import {
    Action,
    Metadata,
    SignedMetadata,
    DeserializedSeq,
    DID,
    EncryptedMessage,
    UnencryptedMessage
} from './actions.js'
const debug = createDebug()

export const PROOF_ENCODING = 'base64pad'

const VERSION = 1

debug('version', VERSION)

interface LogDB extends DBSchema {
    log: {
        key:string;
        value:UnencryptedMessage|EncryptedMessage;
        indexes: {
            id:string;
            seq:string;
            localSeq:string;
            scope:string;
            username:string;
            time:number;
        }
    };
    extra: {
        key:string;
        value:{
            localSeq:number
        };
        indexes: {
            localSeq:string
        }
    };

    // products: {
    //     value: {
    //         name: string;
    //         price: number;
    //         productCode: string;
    //     };
    //     key: string;
    //     indexes: { 'by-price': number };
    // };
}

export interface ReadonlyListener<
    ListenerAction extends Action<any>,
    LogMeta extends Metadata
> {
    (action:ListenerAction, meta:LogMeta):void
}

/**
 * A log store for IndexedDB.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology IndexedDB key characteristics}
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB Using IndexedDB}
 *
 * @property {DID} did This device's DID
 */
export class IndexedStore {
    readonly name:string
    readonly username:string
    readonly deviceName:string
    readonly adding:Record<string, boolean> = {}
    private _db?:IDBPDatabase<LogDB>
    readonly did:DID
    readonly sign?:(meta:string)=>Promise<string>

    constructor (opts:{
        username:string,
        deviceName:string,
        did:DID,
        idb:IDBPDatabase<LogDB>,
        sign?:(meta:string)=>Promise<string>
        version?:number
    }, name = 'partylog') {
        this.name = name
        this.deviceName = opts.deviceName
        this.username = opts.username
        this.sign = opts.sign
        /**
         * `did` is added to metadata as the `author` field.
         */
        this.did = opts.did
    }

    /**
     * Factory function b/c async.
     *
     * @param {object} opts parameters
     * @param {string} opts.username A unique username
     * @param {DID} opts.did The DID for the device
     * @param {(meta:string)=>Promise<string>} opts.sign A function that will
     * sign entries.
     * @returns {Promise<InstanceType<typeof IndexedStore>>}
     */
    static async create (opts:{
        username:string,
        did:DID,
        sign?:(meta:string)=>Promise<string>
    }):Promise<InstanceType<typeof IndexedStore>> {
        const deviceName = await createDeviceName(opts.did)
        const idb:IDBPDatabase<LogDB> = await openDB<LogDB>('partylog', VERSION, {
            upgrade (db) {
                const log = db.createObjectStore('log', {
                    autoIncrement: false,
                    keyPath: 'metadata.seq'  // sort by absolute timestamp
                })
                log.createIndex('id', 'metadata.id', { unique: true })
                log.createIndex('seq', 'metadata.seq', { unique: true })
                log.createIndex('localSeq', 'metadata.localSeq', {
                    unique: true
                })
                log.createIndex('scope', 'metadata.scope', {
                    unique: false
                })
                log.createIndex('username', 'metadata.username', {
                    unique: false
                })

                log.createIndex('time', 'metadata.timestamp', {
                    // server could get 2 actions created at the same time
                    // by different devices
                    unique: false
                })

                db.createObjectStore('extra', { keyPath: 'key' })
            }
        })

        const store = new IndexedStore({ ...opts, deviceName, idb })
        return store
    }

    async paginate ():Promise<IDBPCursorWithValue<LogDB>|null> {
        const cursor = await this._db!.transaction<
            'log'|'extra',
            'readonly'
        >('log').store.openCursor()

        return cursor
    }

    /**
     * Add a new domain message to `IndexedDB`. This method creates
     * the metadata.
     *
     * @param {object} content The message content, unencrypted b/c we calculate
     * the `proof` hash here.
     * @param {{ scope:'post'|'private' }} scope The 'scope' field.
     * @param {EncryptedMessage|UnencryptedMessage} [prev] The previous message,
     * for the Merkle chain.
     * @returns {Promise<null|Metadata>} Return `null` if the add operation
     * failed, eg b/c the given ID already exists, or we are already adding it.
     * Return `Metadata` otherwise.
     */
    async add (
        content:object,
        { scope }:{ scope:'post'|'private' },
        prev?:EncryptedMessage|UnencryptedMessage
    ):Promise<Metadata|SignedMetadata|null> {
        const lastAdded = await this.getLastAdded()
        let localSeq:number
        if (lastAdded.localSeq === -1) localSeq = 0
        else localSeq = lastAdded.localSeq + 1

        const timestamp:number = ts()

        // a seq that sorts correctly
        // time + local seq integer + deviceName
        // const seq = '' + time + ':' + localSeq + ':' + this.deviceName
        const seq = [timestamp, localSeq, this.deviceName] as const
        const proof = toString(blake3(stringify(content)), PROOF_ENCODING)

        type PendingMetadata = Omit<Omit<SignedMetadata, 'id'>, 'signature'>

        let newMetadata:PendingMetadata = {
            prev: prev ? prev.metadata!.id : null,
            deviceName: this.deviceName,
            localSeq,
            seq,
            proof,
            scope,
            username: this.username,
            timestamp,
            author: this.did
        }

        /**
         * Add the ID.
         */
        if (this.sign) {
            // sign the metadata, then create the ID
            (newMetadata as Omit<SignedMetadata, 'id'>) = Object.assign(
                newMetadata,
                { signature: await this.sign(stringify(newMetadata)) }
            );

            (newMetadata as SignedMetadata) = Object.assign(
                newMetadata as Omit<SignedMetadata, 'id'>,
                { id: toString(blake3(stringify(newMetadata)), 'base64urlpad') }
            )
        } else {
            // no signature, so just create an ID
            (newMetadata as Metadata) = Object.assign(newMetadata, {
                id: toString(blake3(stringify(newMetadata)), 'base64urlpad')
            })
        }

        /**
         * @TODO encrypt the content
         */
        const entry:EncryptedMessage = {
            metadata: newMetadata as Metadata|SignedMetadata,
            content: JSON.stringify(content)
        }

        if (await this._db!.getFromIndex('log', 'id', entry.metadata.id)) {
            // will not happen
            return null
        }

        await this._db?.put('log', entry, entry.metadata.id)

        return newMetadata as Metadata|SignedMetadata
    }

    /**
     * Get a message by ID
     *
     * @param {string} id The ID
     * @returns {Promise<[Action<T>, Metadata]|[null, null]>}
     */
    async byId (id:string):Promise<
        UnencryptedMessage|EncryptedMessage|undefined
    > {
        const res = await this._db?.getFromIndex('log', 'id', id)
        return res
    }

    /**
     * Delete this database.
     * @returns {void}
     */
    async clean ():Promise<void> {
        this._db?.close()
        await deleteDB(this.name)
    }

    /**
     * Get messages that have been added to the store, but have not
     * been sent to the server yet.
     */
    async getDiff ():Promise<IDBPCursorWithValue<
        LogDB,
        ['log'],
        'log'
    >|undefined|null> {
        const [synced, added] = await Promise.all([
            this.getLastSynced(),
            this.getLastAdded()
        ])

        if (added.localSeq > synced.localSeq) {
            const store = this._db?.transaction('log', 'readonly')
                .objectStore('log')

            const range:IDBKeyRange = IDBKeyRange.bound(
                synced.localSeq,
                added.localSeq
            )

            const cursor = await store!.openCursor(range)

            return cursor
        }

        return null
    }

    /**
     * Get the last added `seq` number of actions.
     * @TODO -- cache this value
     * @returns {Promise<{
     *   localSeq:number,
     *   seq:DeserializedSeq,
     *   id:string
     * }|{ localSeq:-1 }>}
     */
    async getLastAdded ():Promise<{
        localSeq:number,
        seq:DeserializedSeq,
        id:string
    }|{ localSeq:-1 }> {
        const cursor = (await this._db?.transaction('log')
            .store.openCursor(null, 'prev'))

        /**
         * Need to get log entries by our username
         *
         * > you can limit the range of items that are retrieved by using a key
         * > range object
         */

        return (cursor ?
            {
                localSeq: cursor.value.metadata.localSeq,
                seq: cursor.value.metadata.seq,
                id: cursor.value.metadata.id
            } :
            { localSeq: -1 })
    }

    /**
     * Get { localSeq }, the most recent `seq` number synced from this device.
     *
     * @returns {Promise<{ localSeq:number }>}
     */
    async getLastSynced ():Promise<{ localSeq:number }> {
        const data = await this._db?.get('extra', 'lastSynced')

        if (data) {
            return data
        } else {
            return { localSeq: -1 }
        }
    }

    /**
     * @TODO -- delete the content, keep the metadata
     * @TODO -- sync delete actions with the remote store
     *
     * Remove a message from the local store.
     *
     * @param {string} id The ID to delete
     * @returns {Promise<null|EncryptedMessage>} `null` if the ID does not
     * exist, the removed message otherwise.
     */
    async remove (id:string):Promise<EncryptedMessage|UnencryptedMessage|undefined> {
        const entry = await this._db?.get('log', id)
        await this._db?.delete('log', id)

        return entry
    }

    /**
     * Set the last synced values. Should pass this the `seq` value from
     * actions.
     *
     * @param values The `seq` string sent or received
     */
    async setLastSynced (
        value:{ localSeq:number }
    ):Promise<void> {
        await this._db?.put('extra', value, 'lastSynced')
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
 * @param {Partial<Metadata>} firstMeta Some action’s metadata.
 * @param {Partial<Metadata>} secondMeta Other action’s metadata.
 */
export function isFirstOlder (
    firstMeta:{ time:number },
    secondMeta:{ time:number }
):boolean {
    return (firstMeta.time < secondMeta.time)
}

/**
 * Take a `seq` as a string, return an array of its contents.
 * @param {string} seq The `seq` string to parse --
 *   `timestamp:localSeq:deviceName`
 * @returns {DeserializedSeq} An array of `seq` contents
 */
export function deserializeSeq (
    seq:string|-1
):DeserializedSeq|-1 {
    if (seq === -1) return -1
    const parts = seq.split(':')
    return [parseInt(parts[0]), parseInt(parts[1]), parts[2]]
}

/**
 * Take a deserialized `seq`, return the string version.
 * @param seq Deserialized `seq`
 * @returns {string}
 */
export function serializeSeq (seq:DeserializedSeq):string {
    return '' + seq[0] + ':' + seq[1] + ':' + seq[2]
}
