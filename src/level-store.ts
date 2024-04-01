import { BrowserLevel } from 'browser-level'
import charwise from 'charwise'

export class LevelStore {
    level:InstanceType<typeof BrowserLevel>
    readonly name:string = 'partylog'
    readonly deviceName:string

    constructor ({ deviceName }:{ deviceName:string }) {
        this.deviceName = deviceName
        this.level = new BrowserLevel('partylog', {
            keyEncoding: charwise
        })
    }

    // async add (
    //     content:object,
    //     { scope }:{ scope: 'post'|'private' }
    // ):Promise<Metadata|SignedMetadata> {
    //     const lastAdded = await this.getLastAdded()
    // }

    /**
     * Log entries must be sorted by seq, and have and index for our username.
     */
    // async getLastAdded () {
    //     // const iterator = this.level.iterator({ reverse: true, limit: 1 })
    //     // for (const [key, value] of iterator) {
    //     //     console.log('key', key, value)
    //     // }
    // }

    // async add (
    //     content:object,
    //     { scope }:{ scope:'post'|'private' },
    //     prev?:EncryptedMessage|UnencryptedMessage
    // ):Promise<Metadata|SignedMetadata|null> {
    //     const lastAdded = await this.getLastAdded()
    // }
}
