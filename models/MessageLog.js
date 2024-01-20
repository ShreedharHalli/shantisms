const mongoose = require('mongoose');

const MessageLogsSchema = new mongoose.Schema({
    timeStamp: {
        type: Date,
        default: Date.now()
    },
    custName: {
        type: String,
        default: '0'
    },
    custId: {
        type: String,
        default: '0'
    },
    sentTo: {
        type: String,
        default: '0'
    },
    content: {
        type: String,
        default: '0'
    },
    media: {
        type: String,
        default: '0'
    },
    messageId: {
        type: String,
        default: '0'
    },
    status: {
        type: String,
        default: '0'
    },
    sonisirId: {
        type: String,
        default: '0'
    }
});

// fire a function after doc saved to db
/* MessageLogsSchema.post('save', function (doc, next) {
    console.log('new message log was created & saved', doc);

    next();
}); */

const MessageLog = mongoose.model('messagelogs', MessageLogsSchema);

module.exports = MessageLog;