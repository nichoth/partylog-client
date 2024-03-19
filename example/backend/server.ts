import fauna from 'faunadb'
import * as Party from 'partykit/server'
import {
    verifyParsed,
} from '@bicycle-codes/request'
import { parseToken } from '@bicycle-codes/request/parse'
import { createDeviceName, DID } from '@bicycle-codes/identity'
import { getClient } from './get-client.js'
// import { ActionCreator } from '../../src/actions.js'
import { AnyProtocolAction } from '../../src/actions.js'
const { query: q, Client } = fauna

// const ErrorAction = ActionCreator<{ error:string }>('error')

export default class WebSocketServer implements Party.Server {
    room:Party.Room
    client:InstanceType<typeof Client>
    connectedDevices:Record<string, DID> = {}

    constructor (room:Party.Room) {
        this.room = room
        this.client = getClient()
    }

    async init () {
        // there is no lastAdded for the DB as a whole!
        // const lastAdded = await this.client.query(
        //     q.Get(q.Match(q.Index('log_by_user')))
        // )
    }

    async onConnect (conn:Party.Connection, ctx:Party.ConnectionContext) {
        // get token from request query string
        const token = new URL(ctx.request.url).searchParams.get('token') ?? ''

        // in real life, we would check the token author's DID,
        // and verify that they are an allowed user
        const parsed = parseToken(token)
        const { author } = parsed
        const device = await createDeviceName(author)
        this.connectedDevices[device] = author

        console.log(
            `Connected:
            id: ${conn.id}
            deviceID: ${device}
            room: ${this.room.id}
            url: ${new URL(ctx.request.url).pathname}`
        )
    }

    /**
     * @TODO
     *   - Need to check for token replays. Need to save the `seq` of
     *     each token.
     */
    static async onBeforeConnect (request:Party.Request) {
        try {
            // get token from request query string
            const token = new URL(request.url).searchParams.get('token') ?? ''

            // in real life, we would check the token author's DID,
            // and verify that they are an allowed user
            const parsed = parseToken(token)
            // const { author } = parsed
            const isOk = await verifyParsed(parsed)
            if (!isOk) throw new Error('bad token')

            return request  // forward the request to `onConnect`
        } catch (err) {
            return new Response('Unauthorized', { status: 401 })
        }
    }

    onMessage (
        message:string,
        sender: Party.Connection<unknown>
    ):void|Promise<void> {
        // in here, need to process the incoming message
        // types -- 'hello', 'add', 'remove'
        let msg:AnyProtocolAction

        try {
            msg = JSON.parse(message)
        } catch (err) {
            console.log('**Bad JSON**', err)
            sender.send('err Bad JSON')
        }

        // use sender.id in the DB queries
        // need to verify that sender.id matches with our
        // list of DIDs that are allowed.

        // keep an object like { username: { deviceName: DID } }
        // this is an object of all open connections
        // when we get a message,

        const [type, body] = msg!
        if (type === 'hello') {
            const { seq } = body
            console.log('**hello, the sequence number...**', seq)
            // need to compare with server-side DB
            // if we have a higher `seq` string, then send messages
            // if we have a lower `seq`, then request messages
        }

        if (type === 'add') {
            // sync messages have an array of domain actions as message body
            console.log('**handle "sync" message**', msg!)
            console.log('**sync body**', body)
            // add these messages to the `log` store
            this.client.query(q.Map(
                body,
                q.Lambda('message', q.Create(
                    q.Collection('log'), { data: q.Var('message') }
                ))
            ))
        }

        // could make a DB collection per user

        if (type === 'add') {
            // add a single message
            this.client.query(q.Create(
                q.Collection('log'),
                { data: body }
            ))
        }

        /**
         * @TODO
         * handle re-broadcasting messages
         */
        // this.room.broadcast(
        //     message,
        //     [sender.id]  // don't broadcast to the message sender
        // )
    }
}
