# messages
Looking at the protocol for general state sync.

The server is a "dumb" service. It just records messages that we send to to it,
and it will read them back in the correct order.

## scenarios
Here are several scenarios that this protocol accounts for.

### Client goes offline and adds some new messages

The client goes offline for a while, and adds new messages. The server does not
get any additional messages during that time.

The client keeps track of the last message it has synced with the server. It
sees that the `last_synced` message is 7, but the `last_added` message (the
most recent message added to IDB) is at 9.

So the client sends a 'hello' message that includes messages 8 & 9, everything
larger than the `last_synced` record that it has.

The server needs to append the two new messages to its log for that user.

### Client has not added additional messages, server does have new messages

Server gets 'hello' message from client, and the client's `last_added`
number is even with its `last_synced` number (the client has not added any new
messages during this time), so the client's "hello" message does not include
any messages.

*But* the server does have new messages. So we get the client's hello,
and it doesn't have any messages, just the last `seq` number that it has.

We have a later `seq` number, so we send all the messages from the
`seq` in their 'hello' message to our most recent message.

### Client and server both have new stuff

The client goes offline and adds 3 new messages. During that time, the server
gets 5 new messages from a different device. The client comes back online, sees
the `last_synced` number is at 2, which is 3 less than its `last_added` number,
and so it sends a message like this

```js
['hello', { seq: 5, messages: [msg3, msg4, msg5] }]
```

The server gets the hello, and adds the 3 new messages to the DB. It has also
gotten 5 new messages from a different device. The server reads the `seq` in the
client's message, and it can see that the client device is 5 behind, so
it sends the 5 additional messages to the client:

```js
['hello', { messages: [a, b, c, d, e] }]
```

---------------------------------------------------------------------

The record of `last_synced` on the server is more complex.

The server needs to keep a record for each device of the user.
User A has devices 1, 2, 3.

The server needs a record like

```js
{
    device1: {
        lastSynced: 5
    },
    device2: {
        lastSynced: 3
    },
    device3: {
        lastSynced: 7
    }
}
```

-----------------------------------------------------------------------

Note the concept of "subscriptions" here.

We have 3 devices that care about messages related to a single username.

"syncing", from the server's perspective, means sending any new messages from
any of the user's *other* devices. That is, the user is on device 1, and the
server remembers that device 1 has gotten messages up to 42 from device 2, and
up to 46 from device 3. Device 2 and device 3 are now at 52 each, so that means
the server will send 10 new messages from device 2, and 6 new messages from
device 3.

We can keep the messages in a single log, because the `seq` is sortable b/c
it includes a timestamp.

These messages are indexed by device, but they need to be sortable with respect
to each other. That explains the choice of `seq` string --

```js
`${timestamp}:${localSeqNumber}:${deviceName}`
```

This way we can sort all messages together, by the `seq` string. That is,
thinking about level DB, for example, we could put all these messages into a
DB with an index on `seq`, and use a range query effectively.

"give me the HEAD of the log for user A"

user A maps to 3 devices: A1, A2 and A3

I've been thinking of this in terms of a level DB. Meaning, if we create an
index in the right way, then we can quickily get the right messages.

-----------------------------------------------------------------------

Should add an unencrypted 'scope' field to messages.

Any connection from the user's devices would get messages with a scope of
'private'. Connections from a user's friend would get messages with a scope of
'friend'.

## notes
When user A wants to sync, the server can do a query like, "get me any new
messages from `userA/device2` or `userA/device3`" if the request comes from
`userA/device1`.


## other notes

In Half Light, the posts have audience references:

```ts
export type EncryptedPostWithAudiences = {
    post:EncryptedPost,
    id:string,
    audienceIds:string[],
    audiences:Record<string, string>  /* <-- a map from audience ID to
        encrypted post cryptoKey */
}
```

Each post gets its own key, that is encrypted by the audience that points to it.

-------------------------------------------------------------------------

## Mon, 3-18-2024
Need to implement
  * fauna log store
  * indexedDB / level DB store
