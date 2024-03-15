import pkg from 'faunadb'
const { Client } = pkg

export function getClient ():InstanceType<typeof Client> {
    return (new Client({
        secret: process.env.FAUNA_SECRET!
    }))
}
