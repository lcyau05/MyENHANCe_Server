/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// const {onRequest} = require("firebase-functions/v2/https");
// const logger = require("firebase-functions/logger");

require("dotenv").config(); // Load environment variables
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const express = require("express");
const cors = require("cors");

admin.initializeApp(); // This is required for Firestore to work
const corsMiddleware = cors({origin: true}); // Correctly initialize CORS

const db = admin.firestore();

const app = express();

exports.stripeWebhook = functions.https.onRequest({rawBody: true}, async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_ENDPOINT_SECRET;
  let event;
  // Verify the webhook signature
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
  } catch (err) {
    console.log(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`🔹 Received Stripe event: ${event.type}`);

  // Handle different Stripe events
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutSessionCompleted(event.data.object);
      break;

    case "customer.subscription.updated":
      await handleSubscriptionUpdated(event.data.object);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionCancellation(event.data.object);
      break;
    default:
      console.log(`Unhandled event type: ${event.type}`);
      break;
  }

  res.json({received: true});
});

// Function to handle successful checkout session
/**
 * Handles the completion of a Stripe Checkout session.
 * This function stores the Stripe customer ID in Firestore, records the health plan purchase,
 * and initializes claim tracking for the patient.
 *
 * @param {Object} session - The Stripe checkout session object.
 * @param {string} session.client_reference_id - The user ID of the patient.
 * @param {string} session.metadata.planId - The Stripe product ID of the purchased health plan.
 * @param {string} session.customer - The Stripe-generated customer ID.
 * @return {Promise<void>} A promise that resolves when the process is completed.
 */
async function handleCheckoutSessionCompleted(session) {
  // const customerEmail = session.customer_email;
  // const invoiceUrl = session.hosted_invoice_url;
  const userId = session.client_reference_id; // Use client_reference_id to track user
  const planId = session.metadata.planId; // Custom metadata to identify the plan
  const customerId = session.customer; // Stripe's generated customer ID
  console.log("🔹 Processing webhook for user:", userId, "plan:", planId);
  console.log("🔹 Stripe Customer ID:", customerId);

  // Retrieve the selected health plan from Firestore
  const planDoc = await db.collection("health_plans").doc(planId).get();

  if (!planDoc.exists) {
    console.log("❌ No such plan found!");
  }
  const planData = planDoc.data();
  console.log("✅ Retrieved health plan:", planData);

  // Retrieve the patient document from Firestore
  const patientDocRef = admin.firestore().collection("patients").doc(userId);
  const patientDocSnapshot = await patientDocRef.get();

  if (!patientDocSnapshot.exists) {
    console.error("❌ Patient not found for userId:", userId);
  }

  const patientData = patientDocSnapshot.data();

  console.log("✅ Found patientData:", patientData);

  // Add the new health plan purchase to the purchases subcollection
  await patientDocSnapshot.ref.collection("purchases").add({
    health_plan_name: planData.name,
    health_plan_id: planId,
    purchased_at: new Date(),
    stripeCustomerId: customerId,
    subscription_status: "active",
    claims: {
      // Track claims based on the current month
      [`claims_${new Date().getFullYear()}-${(new Date().getMonth() + 1).toString().padStart(2, "0")}`]: planData.claimable_items.reduce((claims, item) => {
        claims[item.name] = {
          used: 0, // Initialize claims count to 0
          limit: item.limit, // Include claim limit
        };
        return claims;
      }, {}),
    },
  });
  console.log("✅ Successfully stored health plan purchase for user:", userId);
  // res.status(200).send("Success");
  // Send the invoice URL to the customer
  // await sendInvoiceEmail(customerEmail, invoiceUrl);
}

// Function to handle subscription cancellations
/**
 * Handles subscription cancellation events from Stripe.
 * Updates the user's subscription status in Firestore.
 *
 * @param {Object} subscription - The Stripe subscription object.
 * @param {string} subscription.customer - The Stripe customer ID associated with the subscription.
 * @return {Promise<void>} A promise that resolves when the subscription status is updated.
 */
async function handleSubscriptionUpdated(subscription) {
  const userId = subscription.client_reference_id; // Use client_reference_id to track user
  const customerId = subscription.customer;
  const cancelAtPeriodEnd = subscription.cancel_at_period_end;

  console.log("✅ Handling...cancelAtPeriodEnd", cancelAtPeriodEnd);

  // Query the 'purchases' subcollection in the 'patients' collection to find the Stripe customer ID
  const purchasesQuerySnapshot = await db.collection("patients")
      .doc(userId) // Assuming you have the patientId available; use the correct method to get it
      .collection("purchases")
      .where("stripeCustomerId", "==", customerId) // Match the Stripe customer ID
      .limit(1) // We expect only one matching purchase document
      .get();

  if (purchasesQuerySnapshot.empty) {
    console.error(`❌ No purchase found for Stripe customer ID: ${customerId}`);
    return;
  }

  // Get the patient document from the first matching purchase document
  const purchaseDoc = purchasesQuerySnapshot.docs[0];
  const patientRef = purchaseDoc.ref.parent.parent; // Get the parent document reference (patient document)

  if (cancelAtPeriodEnd) {
    console.log(`🔹 Subscription will cancel at the end of the period for user: ${userId}`);
    await patientRef.update({
      subscription_status: "inactive", // Set the status to "inactive"
    });
  } else {
    await patientRef.update({
      subscription_status: "active", // Set the status to "inactive"
    });
    // If the subscription is still active
    console.log(`🔹 Subscription remains active for user: ${userId}`);
  }
}
// Function to handle subscription cancellations
/**
 * Handles subscription cancellation events from Stripe.
 * Updates the user's subscription status in Firestore.
 *
 * @param {Object} subscription - The Stripe subscription object.
 * @param {string} subscription.customer - The Stripe customer ID associated with the subscription.
 * @return {Promise<void>} A promise that resolves when the subscription status is updated.
 */
async function handleSubscriptionCancellation(subscription) {
  console.log("✅ Successfully cancelled subscription", subscription);
}

// /**
//  * Sends an invoice email to the customer with the provided invoice URL.
//  *
//  * @param {string} customerEmail - The email address of the customer.
//  * @param {string} invoiceUrl - The hosted invoice URL from Stripe.
//  * @return {Promise<void>} A promise that resolves when the email is sent.
//  */
// Function to send invoice email (you can use a mail service like Nodemailer)
// async function sendInvoiceEmail(customerEmail, invoiceUrl) {
//   const nodemailer = require('nodemailer');

//   let transporter = nodemailer.createTransport({
//     service: 'gmail',
//     auth: {
//       user: 'your-email@gmail.com',
//       pass: 'your-email-password',
//     },
//   });

//   const mailOptions = {
//     from: 'your-email@gmail.com',
//     to: customerEmail,
//     subject: 'Your Invoice from Enhance24p4',
//     text: `Dear Customer, \n\nYour invoice is ready. You can view it here: ${invoiceUrl}.\n\nThank you for your purchase!`,
//   };

//   try {
//     await transporter.sendMail(mailOptions);
//     console.log(`Invoice email sent to ${customerEmail}`);
//   } catch (error) {
//     console.error('Error sending email:', error);
//   }
// }

// Middleware
app.use(cors({origin: true}));
app.use(express.json());

// Create payment intent
app.post("/create-checkout-session", async (req, res) => {
  try {
    let {planId, userId} = req.body;
    if (!planId || !userId) {
      return res.status(400).json({error: "Missing planId or userId"});
    }
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({error: "Invalid userId provided"});
    }
    userId = userId.trim() + "\n"; // 🔥 Append newline to match Firestore ID
    console.log("Ends with newline?", userId.endsWith("\n"));
    console.log("patients:", JSON.stringify(userId)); // Show explicit newline
    console.log("patients:", userId);
    console.log("Checking Firestore for userId:", userId, "Type:", typeof userId);
    // Query Firestore to find the document where `stripe_product_id` matches `planId`
    const stuffs = await admin.firestore().collection("patients").get();
    const patientIds = stuffs.docs.map((doc) => doc.id);
    console.log("📋 Existing Firestore patient IDs:", patientIds);

    const planQuerySnapshot = await db.collection("health_plans")
        .where("stripe_product_id", "==", planId)
        .limit(1) // We only expect one result
        .get();

    if (planQuerySnapshot.empty) {
      return res.status(400).json({error: "Invalid plan"});
    }
    // Get the first matching plan document
    const planDoc = planQuerySnapshot.docs[0];
    const selectedPlan = planDoc.data();
    console.log("selectedPlan:", selectedPlan);

    // Retrieve the patient document from Firestore
    const patientDocRef = admin.firestore().collection("patients").doc(userId);
    const patientDocSnapshot = await patientDocRef.get();

    if (!patientDocSnapshot.exists) {
      return res.status(404).json({error: "Patient not found"});
    }

    const customerId = patientDocSnapshot.data().stripeCustomerId;

    let session; // Declare session variable here

    if (!customerId || customerId === null) {
      // If the user doesn't have a Stripe customer ID, create a new Stripe customer
      session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "subscription",
        // customer_email: decryptedEmail && decryptedEmail.includes("@") ? decryptedEmail : null, // Stripe will auto-create the customer if one doesn't exist
        line_items: [
          {
            price: selectedPlan.stripe_price_id, // Get the Stripe price ID dynamically from the plan
            quantity: 1,
          },
        ],
        success_url: `https://ehance24p4.web.app/success.html`,
        cancel_url: `https://ehance24p4.web.app/cancel.html`,
        client_reference_id: userId, // Include user ID to identify the customer in the webhook
        metadata: {
          planId: planDoc.id, // Pass plan ID for later use in webhook
        },
      });
    } else {
      // If the user already has a Stripe customer ID, use it in the session
      session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "subscription",
        customer: customerId, // Use existing Stripe customer ID
        line_items: [
          {
            price: selectedPlan.stripe_price_id,
            quantity: 1,
          },
        ],
        success_url: `https://ehance24p4.web.app/success.html`,
        cancel_url: `https://ehance24p4.web.app/cancel.html`,
        client_reference_id: userId,
        metadata: {
          planId: planDoc.id,
        },
      });
    }
    // const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
    res.json({id: session.id, url: session.url});
    // res.json({clientSecret: paymentIntent.client_secret});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

app.post("/create-customer-portal", async (req, res) => {
  try {
    let {userId, planId} = req.body;
    userId = userId.trim() + "\n"; // 🔥 Append newline to match Firestore ID
    if (!userId || !planId) {
      return res.status(400).json({error: "Missing userId or planId"});
    }
    // Debugging log for incoming request
    console.log("🔹 Customer Portal Request received: userId:", userId, "planId:", planId);

    // Retrieve the patient document from Firestore
    const patientDocRef = admin.firestore().collection("patients").doc(userId);
    const patientDocSnapshot = await patientDocRef.get();

    if (!patientDocSnapshot.exists) {
      return res.status(404).json({error: "Patient not found"});
    }

    // const patientRef = patientQuerySnapshot.docs[0].ref;
    const purchasesSnapshot = await patientDocRef.collection("purchases")
        .where("health_plan_id", "==", planId) // Match the selected plan
        .limit(1)
        .get();

    let customerId;

    if (!purchasesSnapshot.empty) {
      // If purchase exists, use the Stripe customer ID from the purchase
      const purchaseData = purchasesSnapshot.docs[0].data();
      customerId = purchaseData.stripeCustomerId;
    } else {
      console.log(`✅ Found purchase for planId: ${planId}`);
    }

    if (!customerId) {
      return res.status(400).json({error: "User does not have a Stripe Customer ID"});
    }

    // Debugging log before creating the customer portal session
    console.log("🔹 Creating customer portal session for Stripe Customer ID:", customerId);

    // Create the Billing Portal Session
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      // return_url: "myenhance://return-from-stripe", // Change this to your actual return URL
    });

    console.log("✅ Created customer portal session:", session.url);

    res.json({url: session.url});
  } catch (error) {
    console.error("Error creating customer portal:", error);
    res.status(500).json({error: "Failed to create customer portal"});
  }
});

// Fetch patient claims for the current month
exports.getClaims = functions.https.onRequest(async (req, res) => {
  corsMiddleware(req, res, async () => {
    let patientId = req.query.patientId;
    patientId = patientId.trim() + "\n"; // 🔥 Append newline to match Firestore ID
    console.log("✅ patientId in getClaims:", patientId);
    if (!patientId) {
      return res.status(400).send("Patient ID is required");
    }
    const currentYear = new Date().getFullYear();
    const currentMonth = (new Date().getMonth() + 1).toString().padStart(2, "0");
    const claimsKey = `claims_${currentYear}-${currentMonth}`;
    console.log("✅ claimsKey in getClaims:", claimsKey);
    try {
      // const patientsSnapshot = await admin.firestore().collection("patients").get();
      // const patientIds = patientsSnapshot.docs.map((doc) => doc.id);
      // console.log("📋 Existing Firestore patient IDs:", patientIds);
      // res.json(patientIds);

      // Step 1: Check if patient exists in Firestore
      const patientRef = db.collection("patients").doc(patientId);
      // .where("userID", "==", patientId)
      // .limit(1);
      const patientDoc = await patientRef.get();

      if (!patientDoc.exists) {
        console.log(`❌ Patient with ID ${patientId} does not exist in Firestore.`);
        return res.status(404).json({error: "Patient not found"});
      }

      // Fetch patient's points
      const points = patientDoc.data().points || 0;

      console.log(`✅ Patient ${patientId} exists. Fetching purchases...`);

      // // Step 2: Query purchases collection
      // const purchasesRef = patientRef.collection("purchases").orderBy("purchased_at", "desc");
      // const snapshot = await purchasesRef.get();

      // console.log(`✅ Total purchases found: ${snapshot.size}`);

      // if (snapshot.empty) {
      //   console.log(`⚠️ No purchases found for patient: ${patientId}`);
      //   return res.json([]); // Return empty array if no purchases exist
      // }
      const purchasesRef = admin.firestore().collection("patients")
          .doc(patientId)
          .collection("purchases")
          .orderBy("purchased_at", "desc");

      const snapshot = await purchasesRef.get();
      console.log("✅ Total purchases found:", snapshot.size);
      const claimsList = [];

      snapshot.forEach((doc) => {
        const claims = doc.data().claims || {};
        console.log("🔍 claims object:", JSON.stringify(claims));
        const claimsForCurrentMonth = claims[claimsKey] || {};
        console.log("📆 claims for month:", JSON.stringify(claimsForCurrentMonth));

        Object.entries(claimsForCurrentMonth).forEach(([claimName, claimDetails]) => {
          claimsList.push({
            name: claimName,
            used: claimDetails.used,
            limit: claimDetails.limit,
          });
        });
      });
      console.error("Hmmmmmmmms");
      res.json({
        claims: claimsList,
        points: points,
      });
    } catch (error) {
      console.error("Error fetching claims:", error);
      res.status(500).send("Internal Server Error");
    }
  });
});

// Use a claim (increment usage count)
exports.useClaim = functions.https.onRequest(async (req, res) => {
  corsMiddleware(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    let {patientId, claimName} = req.body;
    patientId = patientId.trim() + "\n"; // 🔥 Append newline to match Firestore ID
    console.log("✅ patientId in useClaim:", patientId);

    if (!patientId || !claimName) {
      return res.status(400).send("Patient ID and Claim Name are required");
    }

    try {
      const currentYear = new Date().getFullYear();
      const currentMonth = (new Date().getMonth() + 1).toString().padStart(2, "0");
      const claimsKey = `claims_${currentYear}-${currentMonth}`;

      const purchasesRef = admin.firestore().collection("patients")
          .doc(patientId)
          .collection("purchases")
          .orderBy("purchased_at", "desc");

      const snapshot = await purchasesRef.get();

      let found = false;

      snapshot.forEach(async (doc) => {
        const claims = doc.data().claims || {};
        const claimsForCurrentMonth = claims[claimsKey] || {};

        if (claimsForCurrentMonth[claimName]) {
          found = true;
          const claimDetails = claimsForCurrentMonth[claimName];
          console.log(`🔍 Checking claim "${claimName}": Used - ${claimDetails.used}, Limit - ${claimDetails.limit}`);

          if (claimDetails.used + 1 > claimDetails.limit) {
            return res.status(403).send("❌ Claim limit reached. Cannot redeem anymore.");
          } else {
            claimDetails.used += 1;
            await doc.ref.update({
              [`claims.${claimsKey}.${claimName}`]: claimDetails,
            });
          }
        }
      });
      if (!found) {
        return res.status(404).send("Claim not found");
      }

      res.status(200).send("Claim incremented successfully");
    } catch (error) {
      console.error("Error incrementing claim:", error);
      res.status(500).send("Internal Server Error");
    }
  });
});

exports.redeemPoints = functions.https.onRequest(async (req, res) => {
  corsMiddleware(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    let {patientId, pointsToRedeem} = req.body;
    patientId = patientId.trim() + "\n"; // 🔥 Append newline to match Firestore ID

    if (!patientId || !pointsToRedeem || pointsToRedeem <= 0) {
      return res.status(400).send("Invalid data provided");
    }

    try {
      const patientRef = db.collection("patients").doc(patientId);
      const patientDoc = await patientRef.get();

      if (!patientDoc.exists) {
        return res.status(404).send("Patient not found");
      }

      const currentPoints = patientDoc.data().points || 0;

      if (currentPoints < pointsToRedeem) {
        return res.status(400).send("Not enough points to redeem");
      }

      // Subtract the redeemed points and update the patient's document
      await patientRef.update({
        points: currentPoints - pointsToRedeem,
      });

      res.status(200).send("Points redeemed successfully");
    } catch (error) {
      console.error("Error redeeming points:", error);
      res.status(500).send("Internal Server Error");
    }
  });
});


// Expose the API as a Firebase Function
exports.api = functions.https.onRequest(app);
