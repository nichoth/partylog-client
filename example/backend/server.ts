import fauna from 'faunadb'
import * as Party from 'partykit/server'
import { getClient } from './get-client.js'
import {
    verifyParsed,
} from '@bicycle-codes/request'
import { parseToken } from '@bicycle-codes/request/parse'
import { ActionCreator, AnyAction } from '../../src/actions.js'
const { query: q, Client } = fauna

const ErrorAction = ActionCreator<{ error:string }>('error')

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
            console.log('**the token**', token)

            // in real life, we would check the token author's DID,
            // and verify that they are an allowed user
            const parsed = parseToken(token)
            const { author } = parsed
            console.log('**the token author**', author)
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
        // types -- 'hello', 'add', 'sync'
        let msg:AnyAction

        try {
            msg = JSON.parse(message)
        } catch (err) {
            console.log('**Bad JSON**', err)
            sender.send(JSON.stringify(ErrorAction({ error: 'Bad JSON' })))
        }

        // use sender.id in the DB queries
        // need to verify that sender.id matches with our
        // list of DIDs that are allowed.

        // keep an object like { username: { deviceName: DID } }
        // this is an object of all open connections
        // when we get a message,

        const [type, body] = msg!
        if (type === 'hello') {
            const { lastAdded } = body
            console.log('**hello, last added**', lastAdded)
            // need to compare with server-side DB
            // if we have a higher `seq` string, then send messages
            // if we have a lower `seq`, then request messages
        }

        if (type === 'sync') {
            // sync messages have an array of domain actions as message body
            console.log('**handle "sync" message**', msg!)
            console.log('**sync body**', body)
            // add these messages to the `log` store
            this.client.query(q.Map(
                body,
                q.Lambda('message', q.Create(
                    q.Collection('alice'), { data: q.Var('message') }
                ))
            ))
        }

        // could make a DB collection per user

        if (type === 'add') {
            // add a single message
            this.client.query(q.Create(
                q.Collection('alice'),
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
