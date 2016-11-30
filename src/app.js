"use strict";
const Koa = require('koa')
    , app = new Koa()
    , server = require('http').createServer(app.callback())
    , io = require('socket.io')(server)
    , cors = require('koa-cors')
    , jwt = require('koa-jwt')
    , convert = require('koa-convert')
    , bodyparser = require('koa-bodyparser')
    , router = require('koa-router')()
    , datastore = require('nedb-promise')
    , alimentRepo = datastore({filename: './aliments.json', autoload: true})
    , userRepo = datastore({filename: './users.json', autoload: true});

let alimentsLastUpdate = null;

app.use(async(ctx, next) => { //logger
    const start = new Date();
    await next();
    console.log(`${ctx.method} ${ctx.url} - ${new Date() - start}ms`);
});

app.use(async(ctx, next) => { //error handler
    try {
        await next();
    } catch (err) {
        setIssueRes(ctx.response, 500, [{error: err.message || 'Unexpected error'}]);
    }
});

app.use(bodyparser());
app.use(convert(cors()));

const ALIMENT = '/Aliment'
    , LOGIN = '/api/auth/session'
    , SIGNUP = '/api/signup'
    , LAST_MODIFIED = 'Last-Modified'
    , ETAG = 'ETag'
    , OK = 200
    , CREATED = 201
    , NO_CONTENT = 204
    , NOT_MODIFIED = 304
    , BAD_REQUEST = 400
    , NOT_FOUND = 404
    , METHOD_NOT_ALLOWED = 405
    , CONFLICT = 409;

const jwtConfig = {
    secret: 'bias-secret'
}

function createToken(user) {
    console.log(`create token for ${user.username}`);
    return jwt.sign({username: user.username, _id: user._id}, jwtConfig.secret, { expiresIn: 60*60*60 });
}

function decodeToken(token) {
    let decoded = jwt.decode(token, jwtConfig.secret);
    console.log(`decoded token for ${decoded}`);
    return decoded;
}

router
    .get(ALIMENT, async(ctx) => {
        let res = ctx.response;
        let lastModified = ctx.request.get(LAST_MODIFIED);
        if (lastModified && alimentsLastUpdate && alimentsLastUpdate <= new Date(lastModified).getTime()) {
            res.status = NOT_MODIFIED; //304 Not Modified (the client can use the cached data)
        } else {
            res.body = await alimentRepo.find({});
            if (!alimentsLastUpdate) {
                alimentsLastUpdate = Date.now();
            }
            res.set({[LAST_MODIFIED]: new Date(alimentsLastUpdate)});
        }
    })
    .get([ALIMENT, ':name'].join('/'), async(ctx) => {
        let aliment = await alimentRepo.findOne({name: ctx.params.name});
        let res = ctx.response;
        if (aliment) {
            setAlimentRes(res, OK, aliment); //200 Ok
        } else {
            setIssueRes(res, NOT_FOUND, [{warning: 'Aliment not found'}]); //404 Not Found (if you know the resource was deleted, then return 410 Gone)
        }
    })
    .post(ALIMENT, async(ctx) => {
        let aliment = ctx.request.body;
        console.log(ctx.request);
        let res = ctx.response;
        if (aliment.name && aliment.calories && aliment.fats && aliment.proteins && aliment.carbs) { //validation
            await createAliment(res, aliment);
        } else {
            setIssueRes(res, BAD_REQUEST, [{error: 'Some field is missing'}]); //400 Bad Request
        }
    })
    .post([SIGNUP], async(ctx)=> {
        let user = ctx.request.body;
        let res = ctx.response;
        if (!user.username || !user.password) {
            console.log(`session - missing username and password`);
            setIssueRes(ctx.response, BAD_REQUEST, [{error: 'Both username and password must be set'}])
            return;
        }
        await createUser(res, user);
        if (user && user.password) {
            ctx.status = CREATED;
            let tkn = createToken(user);
            ctx.response.body = {token: tkn};
            console.log(`session - token created `+tkn);
        } else {
            console.log(`session - wrong password`);
            setIssueRes(ctx.response, BAD_REQUEST, [{error: 'Wrong password'}])
        }
    })
    .post([LOGIN], async(ctx) => {
        let reqBody = ctx.request.body;
        console.log(reqBody);
        if (!reqBody.username || !reqBody.password) {
            console.log(`session - missing username and password`);
            setIssueRes(ctx.response, BAD_REQUEST, [{error: 'Both username and password must be set'}])
            return;
        }
        console.log(reqBody.username);
        let user = await userRepo.findOne({username: reqBody.username})
        if (user && user.password === reqBody.password) {
            ctx.status = CREATED;
            ctx.response.body = {token: createToken(user)};
            console.log(`session - token created`);
        } else {
            console.log(`session - wrong password`);
            setIssueRes(ctx.response, BAD_REQUEST, [{error: 'Wrong password'}])
        }
    })
    .put([ALIMENT, ':name'].join('/'), async(ctx) => {
        let aliment = ctx.request.body;
        let name = ctx.params.name;
        let alimentName = aliment.name;
        let res = ctx.response;
        if (alimentName && alimentName != name) {
            setIssueRes(res, BAD_REQUEST, [{error: 'Param name and body name should be the same'}]); //400 Bad Request
            return;
        }
        if (!aliment.name) {
            setIssueRes(res, BAD_REQUEST, [{error: 'Name is missing'}]); //400 Bad Request
            return;
        }
        if (!alimentName) {
            await createAliment(res, aliment);
        } else {
            let persistedAliment = await alimentRepo.findOne({name: name});
            console.log(persistedAliment);
            if (persistedAliment) {
                let updatedCount = await alimentRepo.update({name: name}, aliment);
                setAlimentRes(res, OK, aliment); //200 Ok
                io.emit('aliment-updated', aliment);
            } else {
                setIssueRes(res, METHOD_NOT_ALLOWED, [{error: 'Aliment no longer exists'}]); //Method Not Allowed
            }
        }
    })
    .del([ALIMENT, ':name'].join('/'), async(ctx) => {
        let id = ctx.params.id;
        await alimentRepo.remove({_id: id});
        io.emit('aliment-deleted', {_id: id})
        alimentsLastUpdate = Date.now();
        ctx.response.status = NO_CONTENT; //204 No content (even if the resource was already deleted), or 200 Ok
    });

const setIssueRes = (res, status, issue) => {
    res.body = {issue: issue};
    res.status = status; //Bad Request
}

const createAliment = async(res, aliment) => {
    aliment.version = 1;
    aliment.updated = Date.now();
    let insertedAliment = await alimentRepo.insert(aliment);
    alimentsLastUpdate = aliment.updated;
    setAlimentRes(res, CREATED, insertedAliment); //201 Created
    io.emit('aliment-created', insertedAliment);
}

const createUser = async(res, user) => {
    let insertedUser = await userRepo.insert(user);
    setUserRes(res, CREATED, insertedUser); //201 Created
    io.emit('user-created', insertedUser);
}

const setAlimentRes = (res, status, aliment) => {
    res.body = aliment;
    res.set({[ETAG]: aliment.version, [LAST_MODIFIED]: new Date(aliment.updated)});
    res.status = status; //200 Ok or 201 Created
}

const setUserRes = (res, status, user) => {
    res.body = user;
    res.set({[ETAG]: user.username});
    res.status = status; //200 Ok or 201 Created
}

app
    .use(router.routes())
    .use(router.allowedMethods());

io.on('connection', (socket) => {
    console.log('client connected');
    socket.on('disconnect', () => {
        console.log('client disconnected');
    })
});

(async() => {
    await alimentRepo.remove({});
    for (let i = 0; i < 20; i++) {
        //await alimentRepo.insert({name: `Aliment ${i}`, calories: 100, proteins: 12.0, carbs: 80.3, fats: 6.0});
        console.log(`Aliment ${i} added`);
    }
})();

server.listen(3000);