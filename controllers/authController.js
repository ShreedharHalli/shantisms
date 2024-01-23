const User = require("../models/User");
const jwt = require("jsonwebtoken");
const axios = require('axios');

// handle errors
const handleErrors = (err) => {
    console.log(err.message, err.code);
    let errors = { email: '', password: '' };

    // incorrect email
    if (err.message === 'incorrect email') {
        errors.email = 'That email is not registered';
    }

    // incorrect password
    if (err.message === 'incorrect password') {
        errors.password = 'XXXX password is incorrect';
    }

    // duplicate email error
    if (err.code === 11000) {
        errors.email = 'that email is already registered';
        return errors;
    }

    // validation errors
    if (err.message.includes('user validation failed')) {
        Object.values(err.errors).forEach(({ properties }) => {
            errors[properties.path] = properties.message;
        });
    }

    return errors;

}

const maxAge = 3 * 24 * 60 * 60;
const createToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: maxAge
    });

}


module.exports.signup_get = (req, res) => {
    res.render("signup");
};

module.exports.login_get = (req, res) => {
    res.render("login");
};

module.exports.adminpage_get = (req, res) => {
    res.render("adminpage");
};

module.exports.customerpage_get = (req, res) => {
    res.render("customerpage");
};

module.exports.home_get = (req, res) => {
    res.render("home");
};

module.exports.signup_post = async (req, res) => {
    const { fullName, email, password, smsUserName, smsKey, smsAccUsg, entityId } = req.body;
    try {
        const user = await User.create({ fullName, email, password, smsUserName, smsKey, smsAccUsg, entityId });
        // const token = createToken(user._id);
        // res.cookie('jwt', token, { httpOnly: true, maxAge: maxAge * 1000 });
        res.status(201).json({user: user._id});
    } catch (error) {
        const errors = handleErrors(error);
        console.log(error.message);
        res.status(400).json({ errors });
    }
};

module.exports.login_post = async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.login(email, password);
        const token = createToken(user._id);
        res.cookie('jwt', token, { httpOnly: true, maxAge: maxAge * 1000 });
        res.status(200).json({ user: user._id, email: user.email });
    } catch (error) {
        const errors = handleErrors(error);
        console.log(error.message);
        res.status(400).json({ errors });
    }
};

module.exports.logout_get = (req, res) => {
    res.cookie('jwt', '', { maxAge: 1 });
    res.redirect('/home'); 
}


module.exports.issuecreditsendpoint_post = async (req, res) => {
    let { customerid, credits } = req.body;
    try {
            const soniSirDoc = await User.findOne({ _id: '659e94f92259ef5e6f262d4a' })
            if (soniSirDoc && soniSirDoc.AvailableCredits >=  credits) {
            const updatedCredits = await User.updateOne({ _id: customerid }, { $inc: { AvailableCredits: credits } });
            const reduceCountOfSoniSir = await User.updateOne({ _id: '659e94f92259ef5e6f262d4a' }, { $inc: { AvailableCredits: -credits } });
            res.status(200).json(updatedCredits);
            } else {
                res.status(404).json({ message: 'Insufficient Credits Available.' });
            }
    } catch (error) {
        res.status(400).json(error.message);
    }
};


module.exports.deletecustomer_post = async (req, res) => {
    let { customerId } = req.body;
    const docID = customerId['0'];
try {
    const deletedCustomer = await User.findByIdAndDelete(docID);
    if (deletedCustomer) {
      console.log('Deleted Customer:', deletedCustomer);
      res.json({ message: 'Customer deleted successfully' });
    } else {
      console.log('Customer not found.');
      res.json({ message: 'Customer not found' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'An error occurred while deleting the document' });
  }
};



module.exports.setwebhook_post = async (req, res) => {
    let { customerId, webhookURL } = req.body;
    const docID = customerId['0'];
    try {
        console.log(docID);
        console.log(webhookURL);
            const updatedWebhookURL  = await User.updateOne({ _id: docID }, { $set: { webHookUrl: webhookURL } } );
            res.status(200).json(updatedWebhookURL);
    } catch (error) {
        console.log(error);
        res.status(400).json(error.message);
    }
};




module.exports.showAvailableCreditsToSoniSir_post = async (req, res) => {
    const { customerId } = req.body; // work pending on this
    try {
    const soniSirDoc = await User.findOne({ _id: '659e94f92259ef5e6f262d4a' })
    const soniSirCredits = soniSirDoc.AvailableCredits;
    const allDocs = await User.find({  }).select('AvailableCredits').exec();
    const totalCustomerCredits = allDocs.reduce((total, user) => total + user.AvailableCredits, 0) - soniSirCredits;
        // Make the HTTP request to retrieve the balance sms value
        const url = 'http://sandesh.sonisms.in/getbalance.jsp?user=Chowgule&key=0e465e1124XX&accusage=1';
        const response = await axios.get(url);
        // Parse the data from the response
        const smsCount = response.data;


        // Make the HTTP request to retrieve the balance sms value
        const dlturl = 'http://sandesh.sonisms.in/getbalance.jsp?user=Chowgule&key=0e465e1124XX&accusage=11';
        const dltRes = await axios.get(dlturl);

        // Parse the data from the response
        const dltsmsCount = dltRes.data;


        // res.json({ soniSirCredits, totalCustomerCredits, smsCount, dltsmsCount });
        res.json({ soniSirCredits, totalCustomerCredits, smsCount, dltsmsCount });
    } catch (error) {
        console.log(error);
        res.status(400).json(error.message);
    } 
};

module.exports.updatesmsdetails_post = async (req, res) => {
    const { customerId, smsUserName, smsKey, smsAccUsg, entityId } = req.body;
    try {
        const updatedSmsDetails = await User.updateOne({ _id: customerId }, { $set: { smsUserName: smsUserName, smsKey: smsKey, smsAccUsg: smsAccUsg, entityId: entityId } } );
        res.status(200).json({ message: 'success' });
    } catch (error) {
        console.log(error);
        res.status(400).json(error.message);
    }
};

module.exports.updatepass_post = async (req, res) => {
    const { customerId, oldPass, newPass, confPass } = req.body;
    try {
        User.findOne({ _id: customerId })
        .then(async (user) => {
            if (!user) {
                res.status(404).json({ message: 'invalid customer id' });
            } else {
                console.log(`this is customer id ${ customerId}`)
                // work here
            }
        })
    } catch (error) {
        
    }
};





