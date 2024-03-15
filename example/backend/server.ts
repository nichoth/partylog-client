import fauna from 'faunadb'
import * as Party from 'partykit/server'
import { getClient } from './get-client.js'
import Debug from '@nichoth/debug'
const debug = Debug()
const { query: q, Client } = fauna

/**
 * This is a "full" implementation of a server
 * b/c the logux-fauna package is for mainstream logux
 * we are re-writing the protocol
 */

export default class WebSocketServer implements Party.Server {
    room:Party.Room
    client:InstanceType<typeof Client>

    constructor (room:Party.Room) {
        this.room = room
        this.client = getClient()
    }

    onConnect (conn:Party.Connection, ctx:Party.ConnectionContext) {
        console.log(
            `Connected:
            id: ${conn.id}
            room: ${this.room.id}
            url: ${new URL(ctx.request.url).pathname}`
        )
    }

    /**
     * @TODO implement this
     */
    static async onBeforeConnect (request:Party.Request) {
        try {
            // get token from request query string
            const token = new URL(request.url).searchParams.get('token') ?? ''
            debug('the token', token)

            if (token !== '123') {
                throw new Error('bad token')
            }

            return request  // forward the request to `onConnect`
        } catch (err) {
            return new Response('Unauthorized', { status: 401 })
        }
    }

    onMessage (
        message:string,
        sender: Party.Connection<unknown>
    ):void|Promise<void> {
        this.room.broadcast(
            message,
            [sender.id]  // don't broadcast to the message sender
        )
    }
}
