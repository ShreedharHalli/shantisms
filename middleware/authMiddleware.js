const jwt = require('jsonwebtoken');
const User = require('../models/User');
// const MessageLog = require('./models/MessageLog');
const MessageLog = require('../models/MessageLog');
const requireAuth = (req, res, next) => {
    const token = req.cookies.jwt;

    // check json web token exists & is verified
    if (token) {
        jwt.verify(token, process.env.JWT_SECRET, (err, decodedToken) => {
            if (err) {
                console.log(err.message);
                res.redirect('/home');
            } else {
                console.log(decodedToken);
                next();
            }
        });
    } else {
        res.redirect('/home');
    }

}

// check current user
const checkUser = (req, res, next) => {
    const token = req.cookies.jwt;
    if (token) {
        jwt.verify(token, process.env.JWT_SECRET, async (err, decodedToken) => {
            if (err) {
                console.log(err.message);
                res.locals.user = null;
                next();
            } else {
                let user = await User.findById(decodedToken.id);
                let messageLogs = await MessageLog.find( {custId: decodedToken.id } )
                .sort({ timeStamp: -1 }) // Sort by timeStamp in descending order (latest first)
                .limit(10); // Limit the result to 10 documents
                res.locals.user = user;
                let userListForAdmin = await User.find( {  } );
                res.locals.userListForAdmin = userListForAdmin
                res.locals.messageLogs = messageLogs;
                next();
            }
        });
    } else {
        res.locals.user = null;
        next();
    }

}

module.exports = { requireAuth, checkUser };