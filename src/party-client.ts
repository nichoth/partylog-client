import Debug from '@nichoth/debug'
import { PartySocket } from 'partysocket'
import type { PartySocketOptions } from 'partysocket'
const debug = Debug()

/**
 * This is the websocket connection for partylog.
 */
export class PartyClient {
    party:InstanceType<typeof PartySocket>

    constructor (opts:Partial<PartySocketOptions>) {
        this.party = new PartySocket({
            ...opts,
            host: import.meta.env.DEV ?
                'localhost:1999' :  // local partykit server
                'partylog.nichoth.partykit.dev',
        })

        this.party.onmessage = (ev) => {
            /**
             * @TODO
             * handle incoming messages
             */
            debug('got a message', JSON.parse(ev.data))
        }
    }
}
