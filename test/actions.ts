import { test } from '@bicycle-codes/tapzero'
import { ActionCreator } from '../src/actions.js'

test('action creating', t => {
    // this is an internal function, undocumented
    const renameUser = ActionCreator<{
        userId:string,
        name:string
    }>('user/rename')

    const action = renameUser({ userId: 'alice', name: 'alice' })

    console.log('**action**', JSON.stringify(action, null, 2))

    t.deepEqual(action, {
        type: 'user/rename',
        data: {
            name: 'alice',
            userId: 'alice'
        }
    }, 'should create the expected action object')
})

let renameUser:ReturnType<typeof ActionCreator<{ id, name }>>
let action
test('ActionCreator', t => {
    // this is the API that is exposed
    renameUser = ActionCreator<{ id:string, name:string }>('user/rename')
    action = renameUser({ id: 'alice', name: 'alice' })

    t.deepEqual(action, {
        type: 'user/rename',
        data: {
            name: 'alice',
            id: 'alice'
        }
    }, 'should create the right action object')
})

test('action matcher', t => {
    t.equal(renameUser.match(action), true, 'should match a matching action')
    t.equal(renameUser.match({ type: 'user/rename' }), true,
        'shoudl match a matching object')
    t.equal(renameUser.match({ type: 'testing' }), false,
        'should not match a mismatched action object')
})

test('action.toString', t => {
    const str = renameUser.toString()
    t.equal(str, 'user/rename', 'should return the right string for the action')
})
