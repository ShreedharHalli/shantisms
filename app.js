const dotenv = require("dotenv");
const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser')
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fileUpload = require("express-fileupload");
const fs = require('fs');
const path = require('path');
const authRoutes = require('./routes/authRoutes');
const { requireAuth, checkUser } = require('./middleware/authMiddleware');
const { Server } = require("socket.io");
const http = require("http");
const User = require('./models/User');
const MessageLog = require('./models/MessageLog');
const axios = require('axios');


dotenv.config();
const sessionMap = new Map();
/* 
setTimeout(() => {
  console.log("SCREENSHOT");
  client.pupPage.screenshot({ path: "/tmp/screenshot.png" });
}, 60000);
        msg.reply(text, null, { linkPreview: true });
 */

const app = express();
const PORT = process.env.PORT || 80
const server = http.createServer(app);
const io = new Server(server);

// middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cookieParser());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(fileUpload())// https://sebhastian.com/express-fileupload/
// https://www.npmjs.com/package/express-fileupload

app.set('views', path.join(__dirname, 'views'));
// view engine
app.set('view engine', 'ejs');




mongoose.connect(process.env.MONGODBURI).then(e => {
  server.listen(PORT);
  console.log('Mongodb connected and server listening on port ' + PORT);
  initiateAllWhatsappClients();
})
  .catch(error => {
    console.log(error.message)
  });

// Routes
app.get('*', checkUser);
app.get('/', (req, res) => res.render('home'));
app.get('/customerpage', requireAuth, (req, res) => res.render('customerpage'));
app.get('/adminpage', requireAuth, (req, res) => res.render('adminpage'));
app.use(authRoutes);




// socket io
io.on("connection", (socket) => {
  // deleteSessionfolder (sessionId) // get the session id from front end
  console.log('A new socket connection', socket.id);
  socket.on("generateQrCode", async (customerId) => {
    console.log('Generate QR code');
    const clientIdString = `${customerId}-${generateRandomString()}`
    const client = whatsappFactoryFunction(clientIdString); // customer docid + - + randomly generated string
    let qrCount = 0;
    client.on('qr', (qr) => {
      QRCode.toDataURL(qr, (err, url) => {
        // console.log(url);
        qrCount++;
        console.log("inc: " + qrCount);
        socket.emit('qrCodeGenerated', url);
      });
    });

    client.on('authenticated', () => {
      console.log('AUTHENTICATED');
      socket.emit('clientIsAuthenticated');
    });

    client.on('auth_failure', msg => {
      // Fired if session restore was unsuccessful
      // delete connected whatsapp number from the document and theauth files
      console.error('AUTHENTICATION FAILURE', msg);
    });
    client.on('ready', async () => {
      sessionMap.set(clientIdString, {
        id: clientIdString,
        client: client,
      });
      console.log('Client is ready!');
      // socket.emit('ClientIsReady');
      let connectedWhatsappNo = client.info.wid.user;
      console.log('connected Whatsapp No is ' + connectedWhatsappNo);
      insertClientDetailstoCustDoc(customerId, connectedWhatsappNo, clientIdString)
    });
    client.initialize();
  });
});


// Function to create a new WhatsApp client instance
function whatsappFactoryFunction(clientId) {
  const client = new Client({
    restartOnAuthFail: true,
    qrMaxRetries: 10, // keep it outside of the puppeteer object
    puppeteer: {
      executablePath: '/usr/bin/google-chrome-stable',
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ],
    },
    authStrategy: new LocalAuth({
      clientId: clientId,
    }),
  });

  return client;  // Return the client instance, not the Client class
};


async function insertClientDetailstoCustDoc(customerId, connectedWhatsappNo, clientId) {
  User.findOne({ _id: customerId })
    .then(async (user) => {
      if (!user) {
        console.log('Customer doc not found in database');
        return;
      } else {
        // waSecretKey: generateRandomSecretKey()
        await User.updateOne({ _id: customerId }, { $set: { waSecretKey: generateRandomSecretKey() } });
        const sessionObj = { client: clientId, connectedWano: connectedWhatsappNo };
        User.updateOne({ _id: customerId }, { $push: { connectedWhatsAppDevices: sessionObj } })
          .then(updatedUser => {
            console.log('Object pushed into connectedWhatsAppDevices array:', updatedUser);
          })
          .catch(error => {
            console.log(error.message);
          })
      }
    })
};




app.post('/deleteConnectedwhatsapp', requireAuth, async (req, res) => {
  try {
    const { customerId, waNo } = req.body;

    // Find the user with the specified connected WhatsApp device
    const doc = await User.findOne({ "connectedWhatsAppDevices.connectedWano": waNo });

    if (!doc) {
      console.log('User not found');
      return res.status(404).json({ message: 'User not found' });
    }

    const connectedDevice = doc.connectedWhatsAppDevices.find(device => device.connectedWano === waNo);

    if (!connectedDevice) {
      console.log('Connected device not found');
      return res.status(404).json({ message: 'Connected device not found' });
    }

    const clientId = connectedDevice.client;

    // Get the clientObj from the sessionMap
    const clientObj = sessionMap.get(clientId);

    if (!clientObj) {
      console.log('Client object not found in sessionMap');
      return res.status(500).json({ message: 'Internal server error' });
    }

    // Get the WhatsApp client from clientObj
    const client = clientObj.client;

    // Logout and destroy the client
    await client.logout();
    await client.destroy();

    // Update the user document to remove the connected WhatsApp device
    await User.updateOne(
      { "connectedWhatsAppDevices.connectedWano": waNo },
      { $pull: { "connectedWhatsAppDevices": { connectedWano: waNo } } }
    );

    // Delete the session folder
    const folderName = `session-${clientId}`;
    const folderPath = path.join(__dirname, '.wwebjs_auth', folderName);

    try {
      // Use fs.promises.access to check if the folder exists
      await fs.promises.access(folderPath);

      // Delete the folder if it exists
      await fs.promises.rm(folderPath, { recursive: true });
      console.log(`Folder '${folderName}' deleted successfully`);
    } catch (err) {
      console.log(`Error deleting folder '${folderName}': ${err.message}`);
    }

    res.status(200).json({ message: 'Client Destroyed Successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Internal server error' });
  }
});


async function initiateAllWhatsappClients() {
  console.log('Initiating all WhatsApp clients...');
  const users = await User.find({ "connectedWhatsAppDevices": { $exists: true, $ne: [] } });
  for (const user of users) { // USERS LOOP
    const connectedDevices = user.connectedWhatsAppDevices;
    for (device of connectedDevices) { // CONNECTED DEVICES LOOP
      try {
        const clientId = device.client;
        const client = whatsappFactoryFunction(clientId);
        const customerId = user._id;

        client.on('ready', async () => {
          console.log(`${device.connectedWano} ' is connected and in the ready state`);
          sessionMap.set(clientId, {
            id: clientId,
            client: client,
          });
        });

        client.on('message_ack', async (msg, ack) => {
          // console.log(`this is ack number ${ack} and message is ${JSON.stringify(msg)}`);
          // Handle message acknowledgment
          switch (ack) {
            case 3:
              // The message was read
              // console.log('The message was SEEN', msg.body, 'and the id is ' + msg._data.id._serialized);
              const setMsgStatusToSeen = await MessageLog.updateOne({ messageId: msg._data.id._serialized }, { $set: { status: 'Seen' } });
              // console.log(setMsgStatusToSeen);
              // Update message doc here
              break;
            // Add more cases as needed
            case -1:
              // Handle ACK_ERROR
              break;
            case 0:
              // Handle ACK_PENDING
              break;
            case 1:
              // Handle ACK_SERVER
              break;
            case 2:
              // Handle ACK_DEVICE
              // Delivered event
              // console.log('The message was DELIVERED', msg.body, 'and the id is ' + msg._data.id._serialized);
              const setMsgStatusToDelivered = await MessageLog.updateOne({ messageId: msg._data.id._serialized }, { $set: { status: 'Delivered' } });
              // console.log(setMsgStatusToDelivered);
              break;
            case 4:
              // Handle ACK_PLAYED
              break;
            default:
              // Handle other cases if necessary
              break;
          }
        });

        client.on('disconnected', async (reason) => { // this event is not firing
          console.log('Client was logged out', reason);
          setTimeout(() => {
            client.destroy();
          }, 5000);
          User.updateOne({ _id: user._id }, { $pull: { connectedWhatsAppDevices: { client: clientId, connectedWano: device.connectedWano } } })
            .then(updatedUser => {
              console.log('Client Object removed from the database ', updatedUser);
            })
            .catch(error => {
              console.log(error.message);
            })
          const folderName = `session-${clientId}`
          // Construct the full path to the folder
          const folderPath = path.join(__dirname, '.wwebjs_auth', folderName);
          // Check if the folder exists before attempting to delete
          // Check if the folder exists before attempting to delete
          const folderExists = await new Promise((resolve) => {
            fs.access(folderPath, (err) => {
              resolve(!err);
            });
          });
          console.log(folderExists);
          if (folderExists) {
            // Delete the folder
            await fs.promises.rm(folderPath, { recursive: true });
            console.log(`Folder '${folderName}' deleted successfully`);
          } else {
            console.log(`Folder '${folderName}' does not exist`);
          }
        });
        client.on('auth_failure', (msg) => {
          console.error('Authentication failure', msg);

        });
        await client.initialize();
      } catch (error) {
        console.log(error);
      }
    };
  }
};



app.post('/api/sendmessage', async (req, res) => {
  let { customerId, message, mobileno, messagetype, senderwano } = req.body;
  // res.status(200).json({ custId: customerId, message: message, mobileno: mobileno, messagetype: messagetype  });
  try {
    User.findById(customerId)
      .then(async (user) => {
        if (!user) {
          res.status(404).json({
            status: false,
            response: 'Customer not found',
          });
        } else {
          if (user.AvailableCredits >= 1) {
            for (const device of user.connectedWhatsAppDevices) {
              if (device.connectedWano === senderwano) {
                const clientId = device.client;
                const clientObj = sessionMap.get(clientId);
                const client = clientObj.client;
                if (messagetype === 'text') {
                  await client.sendMessage(`${mobileno}@c.us`, message).then(async (response) => {
                    const messageId = response._data.id._serialized;
                    MessageLog.create({ custName: user.fullName, custId: customerId, sentTo: mobileno, content: message, media: 0, messageId: messageId, status: 'sent' })
                    await User.updateOne({ _id: customerId }, { $inc: { AvailableCredits: -1 } });
                    res.status(200).json({
                      status: true,
                      response: "Message sent successfully"
                    });
                  }).catch(err => {
                    console.log(err);
                    res.status(500).json({
                      status: false,
                      response: err
                    });
                  });
                }
                break;
              }
            }
          }
        }
      })
  } catch (error) {
    console.log(error);
    if (error.message.includes('Cast to ObjectId')) {
      return res.status(404).json({ error: 'Invalid Customer ID' });
    } else {
      res.status(500).json({ status: false, response: error.message });
    }
  }
});



app.post('/api/sendbulk', async (req, res) => {
  const tonums = req.body.tonums;
  const message = req.body.message;
  const smsCustId = req.body.smscustid;
  const waKey = req.body.wakey;
  const entityid = req.body.entityid;
  const senderwano = req.body.senderwano;
  const messageType = req.body.messagetype.toLowerCase();
  const via = req.body.via.toLowerCase() || 'whatsapp';
  const file = req.files && req.files.file ? req.files.file : null;
  const payloadCount = convertStringToArray(tonums).length;
  const fileName = req.files && req.files.file.name ? req.files.file.name : null;
  // sms variables
  const tempid = req.body.tempid;
  const senderid = req.body.senderid; // when fal msg is given
  const idno = req.body.idno;
  const unicode = req.body.unicode; //language
  const time = req.body.time;
  const accusage = req.body.accusage;
  const fileURL = req.body.fileurl;
  const fallBackMessage = req.body.fallbackmsg; // fallback

  // whatsapp variables
  const whatsappCustId = req.body.whatsappcustid;
  const senderWhatsappNo = req.body.fromnum;

  if (via === 'sms') {
    if (message.length > 0) {
      try {
        User.findById(whatsappCustId)
          .then(async (user) => {
            if (!user) {
              // Handle case where user is not found
              res.status(404).json({
                status: false,
                response: "Customer Not Found"
              });
            } else {
              if (waKey === user.waSecretKey) {
              // const response = await sendBulksms(smsCustId, mobiles, message, tempid, senderid, idno, unicode, time, accusage)
              const response = await sendBulksms(user, tonums, message, tempid, idno, unicode, time, accusage, senderid, entityid)
              res.status(200).send({
                response: response
              })
            } else {
              res.status(500).send({
                message: "Invalid secret key"
              })
            }
            }
          })
      } catch (error) {
        res.status(500).send({
          message: error.message
        })
      }

    }
  } else if (via === 'whatsapp') {
    try {
      User.findById(whatsappCustId)
        .then(async (user) => {
          if (!user) {
            // Handle case where user is not found
            res.status(404).json({
              status: false,
              response: "Customer Not Found"
            });
          } else {
            if (user.AvailableCredits >= payloadCount) {
              for (const device of user.connectedWhatsAppDevices) {
                if (device.connectedWano === senderWhatsappNo) {
                  const clientId = device.client;
                  const clientObj = sessionMap.get(clientId);
                  const response = await sendbulkWhatsapp(clientObj, tonums, message, messageType, file, fileURL, idno, tempid, senderid, entityid, unicode, accusage, user, fileName, fallBackMessage, senderWhatsappNo)
                  res.status(200).send({
                    response: response
                  })
                }
              }
            } else {
              res.status(500).send({
                message: "Inssufficient credits, Please top up your credits"
              })
            }
          }
        });
    } catch (error) {
      console.log(error);
      if (error.message.includes('Cast to ObjectId')) {
        return res.status(404).json({ error: 'Invalid Customer ID' });
      } else {
        res.status(500).json({ status: false, response: error.message });
      }
    }
  }

});


async function sendbulkWhatsapp(clientObj, tonums, message, messageType, file, fileURL, idno, tempid, senderid, entityid, unicode, accusage, user, fileName, fallBackMessage, senderWhatsappNo) {
  return new Promise(async (resolve, reject) => {
    const supportedFormats = ['jpeg', 'jpg', 'png', 'gif', 'pdf', 'xls', 'xlsx', 'mp4', 'mkv', 'avi', 'mov', '3gp'];
    // dont use const
    let whatsappMsgSentCount = '';
    let results = [];
    let isFileFormatSupported = false;
    let isURLFileFormatSupported = false;

    if (file) {
      filePath = await manageUploadedFile('create', file); // TODO: CHECK TMP FOLDER
      // Check if the file format is supported
      const fileFormat = fileName.split('.').pop().toLowerCase();
      isFileFormatSupported = supportedFormats.includes(fileFormat)
    }

    if (fileURL) {
      const { filePath, fileExtension } = await downloadFileFromUrl(fileURL, 'create'); // TODO: CHECK TMP FOLDER
      filePath = filePath
      isURLFileFormatSupported = supportedFormats.includes(fileExtension)
    }

    const mobArr = convertStringToArray(tonums);
    const client = clientObj.client;
    const state = await client.getState();
    if (state === 'CONNECTED') {
      if (messageType === 'text' || (messageType === 'file' && isFileFormatSupported) || (messageType === 'url' && isURLFileFormatSupported)) {
        try {
          for (const number of mobArr) {
            const mobNoAsUID = number.includes("@g.us") ? number : `${number}@c.us`; // CHECK IF CURRENT NUMBER IS GROUP ID
            const isCurrNoIsRegisteredWithWhatsapp = number.includes("@g.us") ? true : await client.isRegisteredUser(number); // RETURNS TRU IF IN CASE OF GROUP ID.
            if (isCurrNoIsRegisteredWithWhatsapp) {
              if (messageType === 'text') {
                console.log(`group id is ${mobNoAsUID}`);
                await client.sendMessage(mobNoAsUID, message).then(async (response) => {
                  const messageId = response._data.id._serialized;
                  MessageLog.create({ custName: user.fullName, custId: user._id, sentTo: number, content: message, media: false, messageId: messageId, status: 'sent', sonisirId: idno, sentFrom: senderWhatsappNo })
                  results.push(`wh, sent, success, ${messageId}, ${idno},${number}, Via: 'Whatsapp'`);
                  whatsappMsgSentCount++
                }).catch(err => {
                  console.log(err);
                  results.push(`wh, failed, failed, ${err}, ${idno},${number},`);
                });
              } else if (messageType === 'file') {
                const media = MessageMedia.fromFilePath(filePath);
                await client.sendMessage(mobNoAsUID, media, { caption: message }).then(async (response) => {
                  const messageId = response._data.id._serialized;
                  MessageLog.create({ custName: user.fullName, custId: user._id, sentTo: number, content: message, media: true, messageId: messageId, status: 'sent', sonisirId: idno, sentFrom: senderWhatsappNo })
                  results.push(`wh, sent, success, ${messageId}, ${idno}, ${number}, Via: 'Whatsapp'`);
                  whatsappMsgSentCount++
                  await manageUploadedFile('delete', file);
                }).catch(err => {
                  console.log(err);
                  results.push(`wh, failed, failed, ${err}, ${idno},${number}`);
                });
              } else if (messageType === 'url') {
                const media = MessageMedia.fromFilePath(filePath);
                await client.sendMessage(mobNoAsUID, media, { caption: message }).then(async (response) => {
                  const messageId = response._data.id._serialized;
                  MessageLog.create({ custName: user.fullName, custId: user._id, sentTo: number, content: message, media: true, messageId: messageId, status: 'sent', sonisirId: idno, sentFrom: senderWhatsappNo })
                  results.push(`wh, sent, success, ${messageId}, ${idno}, ${number}, Via: 'Whatsapp'`);
                  whatsappMsgSentCount++
                  await downloadFileFromUrl(fileURL, 'delete');
                }).catch(err => {
                  console.log(err);
                  results.push(`wh, failed, failed, ${err}, ${idno},${number}`);
                });
              }
              let updatedWhatsappCount = user.AvailableCredits - whatsappMsgSentCount;
              await User.updateOne({ _id: user._id }, { $set: { AvailableCredits: updatedWhatsappCount } });
            } else {
              // CURRENT NUMBER IS NOT REGISTERED WITH WHATSHAPP, SEND FALLBACK MESSAGE
              const smsPortalURL = `http://sandesh.sonisms.in/submitsms.jsp?user=${user.smsUserName}&key=${user.smsKey}&mobile=`;
              const uriEncodedMessage = encodeURIComponent(fallBackMessage);
              const optionalunicode = (unicode !== undefined && unicode !== null) ? `&unicode=${unicode}` : '';
              const optionalidno = (idno !== undefined && idno !== null) ? `&idno=${idno}` : '';
              const smsConstructedURL = `${smsPortalURL}${number}&message=${uriEncodedMessage}&senderid=${senderid}&accusage=${user.smsAccUsg}&entityid=${entityid}&tempid=${tempid}${optionalunicode}${optionalidno}`;
              try {
                const response = await axios.get(smsConstructedURL);
                // console.log(response.data); // Handle the response data here
                results.push(`sms, ${response.data}`);
              } catch (error) {
                console.error(error);
                // results.push({error: error.message});
                results.push(`sms, ${error.message}`);
              }
            }
            const delay = Math.floor(Math.random() * (1000 - 500 + 1)) + 500;
            await sleep(delay);
          }
          resolve(results.join('\n')); // Join the array elements with '\n' to create a multi-line string
        } catch (error) {
          reject(error);
        }
      } else {
        resolve(`wh,failed,'File format is not supported',0,${idno}`);
      }
    } else {
      resolve(`wh,failed,'Wh is not connected',0,${idno}`);
    }
  });
};


async function sendBulksms(user, tonums, message, tempid, idno, unicode, time, accusage, senderid, entityid) {
  const result = [];
  const smsPortalURL = `http://sandesh.sonisms.in/submitsms.jsp?user=${user.smsUserName}&key=${user.smsKey}&mobile=`;
  const uriEncodedMessage = encodeURIComponent(message);
  const optionalunicode = (unicode !== undefined && unicode !== null) ? `&unicode=${unicode}` : '';
  const optionalidno = (idno !== undefined && idno !== null) ? `&idno=${idno}` : '';
  const optionaltime = (time !== undefined && time !== null) ? `&time=${time}` : '';
  const mobArr = convertStringToArray(tonums);
  for (const number of mobArr) {
    try {
      const smsConstructedURL = `${smsPortalURL}${number}&message=${uriEncodedMessage}&senderid=${senderid}&accusage=${user.smsAccUsg}&entityid=${entityid}&tempid=${tempid}${optionalunicode}${optionalidno}${optionaltime}`;
      const response = await axios.get(smsConstructedURL);
      // console.log(response.data); // Handle the response data here
      result.push(`sms, ${response.data}`);
    } catch (error) {
      console.error(error);
      // results.push({error: error.message});
      result.push(`sms, ${error.message}`);
    }
  }
  return result.join('\n'); // Join the array elements with '\n' to create a multi-line string
};



app.get('/api/getwhmsgstatus', async (req, res) => {
  try {
      const { wacustid, wapostids } = req.body;
      const wapostidsArr = wapostids.split(', ');
      const results = [];

      const user = await User.findById(wacustid);

      if (!user) {
          // Handle case where user is not found
          res.status(404).json({
              status: false,
              response: "Customer Not Found"
          });
      } else {
          for (const wapostid of wapostidsArr) {
              const message = await MessageLog.findOne({ custId: wacustid, messageId: wapostid });

              if (message) {
                  const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false };
                  const dateFormatter = new Intl.DateTimeFormat('en-US', options);
                  const formattedDate = dateFormatter.format(message.timeStamp);

                  const dateWithoutComma = formattedDate.replace(/,/g, '');

                  results.push(`Timestamp: ${dateWithoutComma}, Sent From: ${message.sentFrom}, Sent To: ${message.sentTo}, wapostid: ${wapostid}, Status: ${message.status}`);
              } else {
                  results.push(`Invalid wapostid: ${wapostid}`);
              }
          }
          res.status(200).json({
              Response: results.join('\n')
          });
      }
  } catch (error) {
      if (error.message.includes("Cast to ObjectId")) {
          res.status(404).json({
              status: false,
              response: "Invalid customer wacustid"
          });
      } else {
          res.status(400).json({
              status: false,
              message: error.message
          });
      }
  }
});



app.get('/api/iswaregistered', async (req, res) => {
  try {
      const { wacustid, wanos } = req.body;
      const results = [];

      const user = await User.findById(wacustid);

      if (!user) {
          // Handle case where user is not found
          res.status(404).json({
              status: false,
              response: "Customer Not Found"
          });
      } else {
          for (const device of user.connectedWhatsAppDevices) {
              const clientId = device.client;
              const clientObj = sessionMap.get(clientId);
              const client = clientObj.client;
              const state = await client.getState();

              if (state === "CONNECTED") {
                  const nos = convertStringToArray(wanos);
                  for (const wano of nos) {
                      const isRegistered = await client.isRegisteredUser(wano);
                      results.push(`Mob: ${wano}, iswaregistered: ${isRegistered}`);
                  }
              }
              break; // Exit the loop after finding the connected device
          }
      }

      res.status(200).json({
          Response: results.join('\n')
      });
  } catch (error) {
      if (error.message.includes("Cast to ObjectId")) {
          res.status(404).json({
              status: false,
              response: "Invalid customer wacustid"
          });
      } else {
          res.status(400).json({
              status: false,
              message: error.message
          });
      }
  }
});


app.get('/api/getgrpids', async (req, res) => {
  try {
      const { wacustid, wakey, extrctgrpidfrmnum } = req.body;
      // check if the number starts with 91 and if not attach it.
      const fromNum = extrctgrpidfrmnum.toString().startsWith("91") ? extrctgrpidfrmnum : "91" + extrctgrpidfrmnum;
      let results = [];
      let deviceFound = false; // Flag to check if a matching device is found
      const user = await User.findById(wacustid);
      if (!user || user.waSecretKey !== wakey.toString()) {
          res.status(404).json({
              status: false,
              response: "Customer id or Secret Key not found"
          });
      } else {
          for (const device of user.connectedWhatsAppDevices) {
              if (device.connectedWano === fromNum) {
                  deviceFound = true;
                  const clientId = device.client;
                  const clientObj = sessionMap.get(clientId);
                  const client = clientObj.client;
                  const state = await client.getState();
                  if (state === "CONNECTED") {
                      const chats = await client.getChats();
                      const groups = chats.filter(chat => !chat.isReadOnly && chat.isGroup);
                      if (groups.length === 0) {
                          res.status(404).json({
                              status: false,
                              response: "You have no group yet."
                          });
                      } else {
                          groups.forEach((group, i) => {
                              results.push(`Group Name: ${group.name}, ID: ${group.id._serialized}`);
                          });
                          res.status(200).json({
                              results: results.join('\n')
                          });
                      }
                  } else {
                      res.status(404).json({
                          status: false,
                          response: "Invalid Number"
                      });
                  }
              }
          }
          // If the loop completes without finding a matching device
          if (!deviceFound) {
              res.status(404).json({
                  status: false,
                  response: "No matching device found"
              });
          }
      }
  } catch (error) {
      if (error.message.includes("Cast to ObjectId")) {
          res.status(404).json({
              status: false,
              response: "Invalid wacustid"
          });
      } else {
          res.status(400).json({
              status: false,
              response: error.message
          });
      }
  }
});




app.get('/automation/missedcallalert/*', async (req, res) => {
  const phoneNumber = req.url.replace('/automation/missedcallalert/', '');
  const phoneWithoutSymbol = phoneNumber.startsWith('+') ? phoneNumber.substring(1) : phoneNumber;
  console.log(phoneWithoutSymbol);
  try {
  const id = '65be095699b95324ad6794a0-xMiIn9';
  const clientObj = sessionMap.get(id);
  const client = clientObj.client;
    const state = await client.getState();
    let message = ''
    message += 'Dear Sir, ' + '\n';
    message += 'Thank you for calling our Relationship Manager. Shreedhar' +  '\n';
    message += 'We apologize that he missed your call; he must be busy attending to valued customers, just like you.' + '\n';
    message += 'Rest assured, our Relationship Manager will call you back within a short period of time.' + '\n';
    message += 'Senior Relationship Manager : Mr. Sudhir Meghache : 91 78878 92244' + '\n';
    if (state === 'CONNECTED') {
      await client.sendMessage(`${phoneWithoutSymbol}@c.us`, message).then(async (response) => {
      }).catch(err => {
        console.log(err);
      });
    }
  } catch (error) {
    console.log(error.message);
  }
});





















// ---------------------------------HELPER FUNCTIONS --------------------------------

// FUNCTION TO SET RANDOM DELTAY AT BULK WHATSAPP SEND
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}



function manageUploadedFile(action, file) {
  return new Promise((resolve, reject) => {
    try {
      if (action === 'create') {
        const filePath = path.join(__dirname, 'tmp', file.name);

        file.mv(filePath, (err) => {
          if (err) {
            console.error(err);
            reject(err); // Reject the promise on failure
          } else {
            resolve(filePath); // Resolve the promise with the file path on success
          }
        });
      } else if (action === 'delete') {
        const filePath = path.join(__dirname, 'tmp', file.name);

        fs.unlink(filePath, (err) => {
          if (err) {
            console.error(err);
            reject(err); // Reject the promise on failure
          } else {
            resolve(true); // Resolve the promise with true on success
          }
        });
      } else {
        const errorMessage = 'Invalid action';
        console.error(errorMessage);
        reject(new Error(errorMessage)); // Reject the promise with an error for invalid action
      }
    } catch (error) {
      reject(error); // Reject the promise on any other unexpected error
    }
  });
}



// GENERATING RANDOM 6 CHARACTERS STRING TO SAVE CLIENT SESSIONS
function generateRandomString() {
  let result = '';
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const charactersLength = characters.length;

  for (let i = 0; i < 6; i++) {// Changed the loop iteration count to 6
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }

  return result;
}





// Converts string of poorly separated mobile numbers into an array
function convertStringToArray(str) {
  // Replace any occurrences of /, \, ; or space with a comma
  const modifiedStr = str.replace(/[\/\\;\s]/g, ",")

  // Split the modified string into an array using comma as the delimiter
  const arr = modifiedStr.split(",")

  // Remove any empty values from the array
  let newArr = arr.filter(value => value !== "")

  // Iterate through the array and check if each string contains "@g.us"
  for (let i = 0; i < newArr.length; i++) {
    // CHECK IF IT HAS GROUP IDS
    if (!newArr[i].includes("@g.us")) {
      // If it doesn't contain "@g.us", prepend "91" to the string
      newArr[i] = "91" + newArr[i]
    }
    // If it contains "@g.us", leave it as it is
  }

  return newArr
}





// Downloads a file from a given URL and saves it to the specified path.

async function downloadFileFromUrl(fileUrl, action) {
  try {
    if (action === 'create') {
      const response = await axios.get(fileUrl, { responseType: 'stream' });
      const fileName = path.basename(fileUrl);
      const fileExtension = path.extname(fileUrl); // Extract file extension
      const filePath = path.join(__dirname, 'tmp', fileName);

      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      return { filePath, fileExtension };
    } else if (action === 'delete') {
      const fileName = path.basename(fileUrl);
      const filePath = path.join(__dirname, 'tmp', fileName);

      await new Promise((resolve, reject) => {
        fs.unlink(filePath, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      return `File '${fileName}' has been deleted.`;
    } else {
      throw new Error(`Invalid action: ${action}. Use 'create' or 'delete'.`);
    }
  } catch (error) {
    console.error('Error while processing the action:', error);
    throw error;
  }
}




// Converts string of poorly separated mobile numbers into an array
function convertStringToArray(str) {
  // Replace any occurrences of /, \, ; or space with a comma
  const modifiedStr = str.replace(/[\/\\;\s]/g, ",")

  // Split the modified string into an array using comma as the delimiter
  const arr = modifiedStr.split(",")

  // Remove any empty values from the array
  let newArr = arr.filter(value => value !== "")

  // Iterate through the array and check if each string starts with +91
  for (let i = 0; i < newArr.length; i++) {
    if (!newArr[i].startsWith("91")) {
      newArr[i] = "91" + newArr[i].replace(/^0+/, "")
    }
  }
  return newArr
}



// GENERATING RANDOM 6 CHARACTERS STRING TO SAVE CLIENT SESSIONS
function generateRandomSecretKey() {
  let result = '';
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const charactersLength = characters.length;

  for (let i = 0; i < 6; i++) {// Changed the loop iteration count to 6
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }

  return result;
}

