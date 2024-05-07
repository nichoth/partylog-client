import fauna from 'faunadb'
import * as Party from 'partykit/server'
import {
    verifyParsed,
} from '@bicycle-codes/request'
import { parseToken } from '@bicycle-codes/request/parse'
import { createDeviceName, DID } from '@bicycle-codes/identity'
import {
    AnyProtocolAction,
    EncryptedMessage,
    UnencryptedMessage
} from '../../src/actions.js'
import { getClient } from './get-client.js'
const { query: q, Client } = fauna

export default class WebSocketServer implements Party.Server {
    room:Party.Room
    client:InstanceType<typeof Client>
    connectedDevices:Record<string, DID> = {}

    constructor (room:Party.Room) {
        this.room = room
        this.client = getClient()
    }

    async init () {
        // there is no lastAdded for the DB as a whole,
        // only per-user

        // const lastAdded = await this.client.query(
        //     q.Get(q.Match(q.Index('log_by_user')))
        // )
    }

    async onConnect (conn:Party.Connection, ctx:Party.ConnectionContext) {
        const token = new URL(ctx.request.url).searchParams.get('token') ?? ''

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
     *     each token. Keep a map from deviceName to number.
     */
    static async onBeforeConnect (request:Party.Request) {
        try {
            // get token from request query string
            const token = new URL(request.url).searchParams.get('token') ?? ''

            if (!token) {
                return new Response('Unauthorized', { status: 401 })
            }

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

    async onMessage (
        message:string,
        sender: Party.Connection<unknown>
    ):Promise<void> {
        // in here, need to process the incoming message
        // types -- 'hello', 'add', 'remove', 'edit'
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
            const { localSeq } = body
            console.log('**hello, the sequence number...', localSeq)

            // hello messages have an array of domain actions as message body
            // need to compare with server-side DB
            // if we have a higher `seq` string, then send messages
            // if we have a lower `seq`, then request messages

            if (body.messages) {
                await this.client.query(q.Map(
                    body.messages,
                    q.Lambda('message', q.Create(
                        q.Collection('log'), { data: q.Var('message') }
                    ))
                ))
            }
        }

        if (type === 'add') {
            console.log('**handle "add" message**', msg!)
            console.log('**add body**', body)

            await this.client.query(q.Create(
                q.Collection('log', { data: body })
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

function getByDevice (
    client:InstanceType<typeof Client>,
    deviceName:string
) {
    return client.query(q.Map(
        q.Paginate(
            q.Match(q.Index('log_by_device'), deviceName)
        ),
        q.Lambda('msg', q.Get(q.Var('msg')))
    ))
}

function getByUsername (
    client:InstanceType<typeof Client>,
    username:string
):Promise<EncryptedMessage|UnencryptedMessage> {
    return client.query(q.Map(
        q.Paginate(
            q.Match(q.Index('log_by_username'), username)
        ),
        q.Lambda('msg', q.Get(q.Var('msg')))
    ))
}
