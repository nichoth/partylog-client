import { ActionCreator } from '../../src/actions.js'

export const renameUser = ActionCreator<{ id:string, name:string }>('user/rename')
export const increment = ActionCreator<void>('count/increment')
export const decrement = ActionCreator<void>('count/decrement')
export const setCount = ActionCreator<{ value:number }>('count/set')

export const Actions = {
    renameUser,
    increment,
    decrement
}

export const ActionTypes = {
    'user/rename': renameUser,
    'count/increment': increment,
    'count/decrement': decrement,
    'count/set': setCount
}
