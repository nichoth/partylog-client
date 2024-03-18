# indexed DB

## [IndexedDB key characteristics and basic terminology](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology)

> IndexedDB lets you store and retrieve objects that are indexed with a "key."

### All changes happen within transactions.

* cannot execute commands or open cursors outside of a transaction

* same-origin policy


### key-value pairs

* key-value pairs -- The values can be complex data like objects.
  - Can create indexes that use any property of the objects for quick searching
    or sorted enumeration.

### uses requests

> Requests are objects that receive the success or failure DOM events

* have `onsuccess`, `onerror` properties
  - The `result` property is particularly magical. It can be many different
    things.

### object oriented vs relational

> IndexedDB, on the other hand, requires you to create an object store for a
  type of data and persist JavaScript objects to that store

### index

> An index is a specialized object store for looking up records in another
> object store

vs

### [key](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology#key)

> The object store can derive the key from one of three sources: a [key generator](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology#key_generator), a [key path](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology#key_path), or an explicitly specified value.

> in web development, you don't really create or access key generators.

> Each record in an object store must have a key that is unique within the same store

[see stackoverflow](https://stackoverflow.com/questions/32214815/indexeddb-what-is-key-keypath-and-indexname)

>  key is like a primary key in SQL

> Indexes are used to search that "column" in the database.

> For example, suppose your data has the column `hours` and you want to be able to search your database on that column. When creating your database you would create an index for that column:

```js
objectStore.createIndex("hoursColumn", "hours", { unique: false });
```

> I can write data to the objectStore as follows:

```js
db.transaction(storeName, "readwrite").objectStore(storeName).add({
    hours: 20,
    minutes: 30
});
```

> to search your data on the column hours, you could write:

```js
var data = db.transaction(storeName)
    .objectStore(storeName)
    .index("hoursColumn")
    .get(20)
```

> the result would be the first row of data where hours = 20, e.g. `{ hours: 20, minutes: 30 }`
