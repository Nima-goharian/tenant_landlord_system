import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import env from "dotenv";
import passport from "passport"; // Make sure passport is imported
import session from "express-session"; // Required for managing sessions
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import nodemailer from "nodemailer";
import axios from "axios";
import multer from "multer";
import path from "path";

const app = express();
const port = 3000;
env.config(); // Can access to variables via process.env
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.set("view engine", "ejs");
app.set("views", "./views");

// Ensure session is set up before passport initialization
app.use(
  session({
    secret: process.env.PG_PASSWORD,
    resave: false,
    saveUninitialized: true,
  })
);

// Initialize passport
app.use(passport.initialize());
app.use(passport.session());

// PostgreSQL setup
const db = new pg.Client({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT,
});
db.connect();
// Find the logged in user or create one
async function findOrCreateUser(profile) {
  // Getting user's info from google
  const googleId = profile.id;
  const email = profile.emails[0].value;
  const name = profile.displayName;
  //Check if the user already exist
  const query = "SELECT * FROM users WHERE google_id = $1 OR email = $2";
  const existingUser = await db.query(query, [googleId, email]);
  if (existingUser.rows.length > 0) {
    // User already exists
    return existingUser.rows[0];
  }

  // User doesn't exist in data base
  // Creating a user

  const insertQuery =
    "INSERT INTO users (google_id, name,email,role) VALUES ($1,$2,$3,$4) RETURNING * ";
  const newUserRole = "tenant";
  const newUser = await db.query(insertQuery, [
    googleId,
    name,
    email,
    newUserRole,
  ]);
  return newUser.rows[0];
}
// Google OAuth strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "http://localhost:3000/auth/google/callback",
      userProfileURL: "https://www.googleapis.com/oauth2/v3/userinfo",
    },
    async (accessToken, refreshToken, profile, cb) => {
      try {
        const user = await findOrCreateUser(profile);
        cb(null, user);
      } catch (err) {
        console.log(err);
      }
    }
  )
);

// Serialize and deserialize user for session management
passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const userQuery = "SELECT * FROM users WHERE id = $1";
    const user = await db.query(userQuery, [id]);
    done(null, user.rows[0]); // Attach user object to req.user
  } catch (err) {
    done(err, null);
  }
});
// Fetching the properties for the main page
app.get("/properties", async (req, res) => {
  try {
    const properties = await db.query(`
        SELECT id, address, price, bedrooms, bathrooms, image 
        FROM properties 
        LIMIT 6
      `);

    // Convert image to base64 if necessary, or use as is if it's a URL
    const propertiesWithImage = properties.rows.map((property) => ({
      ...property,
      image: property.image
        ? `data:image/jpeg;base64,${property.image.toString("base64")}`
        : "path/to/placeholder-image.jpg",
    }));

    res.json(propertiesWithImage);
  } catch (err) {
    console.error("Server error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Routes
app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/resident-login" }),
  async (req, res) => {
    if (req.user.role === "tenant") {
      res.redirect("/tenant-dashboard"); // Redirect to the tenant dashboard route
    } else {
      res.redirect("/landlord-dashboard"); // Redirect to landlord dashboard if the user is a landlord
    }
  }
);

// Dashboard of the tenant info
app.get("/tenant-dashboard", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/resident-login");
  }

  try {
    const userId = req.user.id;
    const userResult = await db.query(
      "SELECT name, email, role, created_at FROM users WHERE id = $1",
      [userId]
    );
    const user = userResult.rows[0];

    // Fetch messages from the mailbox
    const mailbox = await db.query(
      "SELECT * FROM mailbox WHERE sender_id = $1 OR receiver_id = $1 ORDER BY sent_at DESC",
      [userId]
    );

    // Fetch payment history from the external API
    const paymentResponse = await axios.get(
      "http://localhost:5100/api/v1/payment/card"
    );
    let payments = paymentResponse.data.success
      ? paymentResponse.data.data.data
      : [];

    // Add payment_date to each payment record
    payments = payments.map((payment) => ({
      ...payment,
      payment_date: new Date().toLocaleDateString(), // Or use a specific date if needed
    }));

    res.render("tenant-dashboard", {
      title: "Tenant Dashboard",
      cssFile: "tenant-dashboard.css",
      user: user,
      payments: payments,
      mailbox: mailbox.rows,
    });
  } catch (err) {
    console.error(err);
    res.redirect("/resident-login");
  }
});

// Manage tenant dashboard information
app.get("/tenant-dashboard/profile", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/resident-login");
  }
  const userId = req.user.id;

  // fetch the user information from the users table
  const userQuery =
    "SELECT name, email, role, created_at FROM users WHERE id = $1";
  const userResult = await db.query(userQuery, [userId]);
  const userInfo = userResult.rows[0]; // Get the first row of the result

  res.render("profile", {
    title: "User Profile",
    cssFile: "profile.css",
    userInfo: userInfo, // Pass the userInfo object directly
  });
});

// Inserting new information
app.post("/tenant-dashboard/profile/update", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/resident-login");
  }

  const { name, role } = req.body;
  const userId = req.user.id;

  try {
    const updateQuery = `
        UPDATE users 
        SET name = $1, role = $2
        WHERE id = $3
        RETURNING *;
      `;
    const result = await db.query(updateQuery, [name, role, userId]);
    req.user = result.rows[0]; // Update session user data

    if (role == "landlord") {
      res.redirect("/landlord-dashboard");
    } else {
      res.redirect("/tenant-dashboard");
    }
  } catch (error) {
    console.error("Error updating profile:", error);
    res.status(500).send("Server error");
  }
});

// Mail box
app.get("/tenant-dashboard/mailbox", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/resident-login");
  }

  const userId = req.user.id;

  try {
    // Fetch received messages where the tenant is the receiver
    const mailboxQuery = `
        SELECT m.sender_id, m.receiver_id, m.subject, m.message_content, m.sent_at, sender.email AS sender_email
        FROM mailbox m
        JOIN users sender ON m.sender_id = sender.id
        WHERE m.receiver_id = $1
        ORDER BY m.sent_at DESC
      `;
    const mailboxResult = await db.query(mailboxQuery, [userId]);

    res.render("mailbox", {
      title: "Inbox",
      cssFile: "mailbox.css",
      mailbox: mailboxResult.rows,
      user: req.user,
      isSentView: false, // This flag differentiates between sent and received views
    });
  } catch (err) {
    console.error("Error fetching inbox messages:", err);
    res.status(500).send("Error fetching inbox messages");
  }
});
app.get("/tenant-dashboard/mailbox/sent", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/resident-login");
  }

  const userId = req.user.id;

  try {
    // Fetch sent messages where the tenant is the sender
    const sentMessagesQuery = `
        SELECT m.sender_id, m.receiver_id, m.subject, m.message_content, m.sent_at, receiver.email AS receiver_email
        FROM mailbox m
        JOIN users receiver ON m.receiver_id = receiver.id
        WHERE m.sender_id = $1
        ORDER BY m.sent_at DESC
      `;
    const sentMessagesResult = await db.query(sentMessagesQuery, [userId]);

    res.render("mailbox", {
      title: "Sent Messages",
      cssFile: "mailbox.css",
      mailbox: sentMessagesResult.rows,
      user: req.user,
      isSentView: true, // This flag differentiates between sent and received views
    });
  } catch (err) {
    console.error("Error fetching sent messages:", err);
    res.status(500).send("Error fetching sent messages");
  }
});

// Composing a new message
app.get("/tenant-dashboard/mailbox/new", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "tenant") {
    return res.redirect("/resident-login");
  }

  try {
    // Assuming you have a way to get the tenant's landlord ID
    const tenantId = req.user.id;
    const landlordQuery = `
        SELECT l.id, l.name, l.email
    FROM tenant_landlord tl
    JOIN users l ON tl.landlord_id = l.id
    WHERE tl.tenant_id = $1
      `;
    const landlordResult = await db.query(landlordQuery, [tenantId]);
    const landlord = landlordResult.rows[0];

    if (!landlord) {
      res.render("compose-message", {
        title: "Composing message",
        user: req.user,
        landlord: null,
        cssFile: "compose-message.css",
        error: "No landlord found for your account.",
      });
    } else {
      res.render("compose-message", {
        title: "Composing message",
        user: req.user,
        landlord: landlord,
        cssFile: "compose-message.css",
        error: null,
      });
    }
  } catch (error) {
    console.error("Error fetching landlord for tenant:", error);
    res.status(500).send("Error loading compose message page");
  }
});

// Sending email for tenant
app.post("/tenant-dashboard/mailbox/send", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/resident-login");
  }

  const { receiver_id, subject, message_content } = req.body;

  try {
    // Check if the receiver exists
    const receiverResult = await db.query(
      "SELECT id, email FROM users WHERE id = $1",
      [receiver_id]
    );

    if (receiverResult.rows.length === 0) {
      // Render the view with an error message and necessary context
      return res.render("compose-message", {
        title: "Compose New Message",
        cssFile: "compose-message.css",
        user: req.user, // Ensure user context is passed
        landlord: null, // or pass the actual landlord if available
        error: "The specified receiver does not exist in our database.",
      });
    }

    // Insert the new message into the mailbox table
    const insertQuery = `
      INSERT INTO mailbox (sender_id, receiver_id, subject, message_content, sent_at)
      VALUES ($1, $2, $3, $4, NOW())
    `;

    await db.query(insertQuery, [
      req.user.id,
      receiver_id,
      subject,
      message_content,
    ]);

    // Redirect back to the mailbox after successfully sending the message
    res.redirect("/tenant-dashboard/mailbox");
  } catch (err) {
    console.error("Error sending message:", err);
    res.status(500).send("An error occurred while sending the message.");
  }
});

// Rent payment gateway
app.get("/tenant-dashboard/pay-rent", (req, res) => {
  res.render("create-payment-intent", {
    title: "Payment gateway",
    cssFile: "pay-rent.css",
    user: req.user, // Pass the logged-in user to the view
  });
});

// Handling the payment
app.post("/tenant-dashboard/pay-rent", async (req, res) => {
  const {
    amount,
    card_type,
    card_holder_name,
    card_number,
    expiryMonth,
    expiryYear,
    cvv,
    currency = "CAD", // default to CAD if not specified
  } = req.body;

  const paymentData = {
    app_name: "Tenant Payment App",
    service: "Rent Payment",
    customer_email: req.user.email, // get email from logged-in user
    card_type,
    card_holder_name,
    card_number,
    expiryMonth,
    expiryYear,
    cvv,
    amount,
    currency,
  };

  try {
    // Send paymentData to the fake payment API
    const response = await fetch("http://localhost:5100/api/v1/payment/card", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(paymentData),
    });

    if (!response.ok) throw new Error("Payment failed");

    const responseData = await response.json();

    // Redirect back to the tenant dashboard on success
    res.redirect("/tenant-dashboard");
  } catch (error) {
    console.error("Error processing payment:", error);
    res.status(500).send("Payment processing error");
  }
});

app.get("/tenant-dashboard/properties", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/resident-login");
  }

  try {
    const propertiesResult = await db.query(
      "SELECT * FROM properties ORDER BY created_at DESC"
    );
    res.render("tenant-properties", {
      title: "Available Properties",
      cssFile: "tenant-properties.css",
      properties: propertiesResult.rows,
      user: req.user,
    });
  } catch (err) {
    console.error(err);
    res.redirect("/tenant-dashboard");
  }
});

// Route for displaying the application form for a specific property
app.get("/properties/:property_id/apply", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/resident-login");
  }

  const propertyId = req.params.property_id;

  try {
    // Fetch property details for display on the application page (optional)
    const propertyResult = await db.query(
      "SELECT * FROM properties WHERE id = $1",
      [propertyId]
    );

    if (propertyResult.rows.length === 0) {
      return res.status(404).send("Property not found.");
    }

    const property = propertyResult.rows[0];
    res.render("tenant-application", {
      title: "Apply for Property",
      cssFile: "tenant-applications.css",
      property: property,
      user: req.user, // Pass logged-in user details if needed
    });
  } catch (err) {
    console.error("Error loading application form:", err);
    res.status(500).send("Server error.");
  }
});
// Submitting the apllication form
app.post("/tenant-dashboard/submit-application", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/resident-login");
  }

  const {
    property_id,
    full_name,
    contact_number,
    email,
    employer_name,
    job_title,
    monthly_income,
    length_of_stay,
    number_of_occupants,
    pets,
    emergency_contact,
    emergency_contact_number,
  } = req.body;

  const tenantId = req.user.id;
  const applicationDate = new Date();
  const status = "Pending"; // Default status for new applications

  try {
    const query = `
        INSERT INTO property_applications (
          property_id, tenant_id, full_name, contact_number, email,
          employer_name, job_title, monthly_income, length_of_stay,
          number_of_occupants, pets, emergency_contact, emergency_contact_number,
          application_date, status
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
        )
      `;
    await db.query(query, [
      property_id,
      tenantId,
      full_name,
      contact_number,
      email,
      employer_name,
      job_title,
      monthly_income,
      length_of_stay,
      number_of_occupants,
      pets,
      emergency_contact,
      emergency_contact_number,
      applicationDate,
      status,
    ]);

    res.redirect("/tenant-dashboard"); // Redirect back to the tenant dashboard after successful submission
  } catch (err) {
    console.error("Error submitting application:", err);
    res.status(500).send("Error submitting application");
  }
});

// Applications tenant submitted
app.get("/tenant-dashboard/my-applications", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/resident-login");
  }

  const tenantId = req.user.id;

  try {
    const query = `
        SELECT pa.property_id, p.address, pa.application_date, pa.status, pa.full_name, pa.contact_number
        FROM property_applications pa
        JOIN properties p ON pa.property_id = p.id
        WHERE pa.tenant_id = $1
        ORDER BY pa.application_date DESC
      `;
    const applications = await db.query(query, [tenantId]);

    res.render("my-applications", {
      title: "My Applications",
      cssFile: "my-applications.css",
      applications: applications.rows,
      user: req.user,
    });
  } catch (err) {
    console.error("Error fetching applications:", err);
    res.status(500).send("Error fetching applications");
  }
});
app.get("/tenant-dashboard/download-documents", (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "tenant") {
    return res.redirect("/resident-login");
  }
  res.render("download-documents", {
    title: "Download Documents",
    documents: [
      {
        name: "Rental Application Form",
        url: "https://legaltemplates.net/form/rental-application/",
      },
      {
        name: "Lease Agreement Template",
        url: "https://ipropertymanagement.com/templates/rental-application-form",
      },
    ],
    cssFile: "mailbox.css",
  });
});
// landlord dashboard route
app.get("/landlord-dashboard", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "landlord") {
    return res.redirect("/resident-login");
  }

  const landlordId = req.user.id;

  try {
    // Fetch tenants associated with this landlord
    const tenants = await db.query(
      `SELECT u.name, u.email
         FROM users u
         JOIN tenant_landlord tl ON u.id = tl.tenant_id
         WHERE tl.landlord_id = $1`,
      [landlordId]
    );
    const tenantEmails = tenants.rows.map((tenant) => tenant.email);

    const paymentResponse = await axios.get(
      "http://localhost:5100/api/v1/payment/card"
    );
    let payments = paymentResponse.data.success
      ? paymentResponse.data.data.data
      : [];

    // Add payment_date to each payment record
    payments = payments.map((payment) => ({
      ...payment,
      payment_date: new Date().toLocaleDateString(), // Or a specific date if available
      customer_email: payment.customer_email, // Ensure this field is provided by the API
    }));

    // Fetch mailbox messages related to the landlord
    const mailboxQuery = `
      SELECT 
          m.sender_id, 
          m.receiver_id, 
          m.subject, 
          m.message_content, 
          m.sent_at, 
          sender.email AS sender_email,
          sender.name AS sender_name,
          receiver.name AS receiver_name,
          receiver.email AS receiver_email
      FROM 
          mailbox m
      JOIN 
          users sender ON m.sender_id = sender.id
      JOIN 
          users receiver ON m.receiver_id = receiver.id
      WHERE 
          m.receiver_id = $1
      ORDER BY 
          m.sent_at DESC
  `;
    const mailboxResult = await db.query(mailboxQuery, [landlordId]);

    res.render("landlord-dashboard", {
      title: "Landlord Dashboard",
      cssFile: "landlord-dashboard.css",
      tenants: tenants.rows,
      payments: payments, // Pass filtered payment data to the template
      mailbox: mailboxResult.rows,
      user: req.user,
    });
  } catch (err) {
    console.error(err);
    res.redirect("/resident-login");
  }
});
// add tenats to a landlord

app.get("/landlord-dashboard/add-tenant", (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "landlord") {
    return res.redirect("/resident-login");
  }
  res.render("add-tenant", {
    title: "Add Tenant",
    cssFile: "add-tenant.css",
    error: null, // Pass error as null initially
  });
});

// Adding tenant for the landlord
app.post("/landlord-dashboard/add-tenant", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "landlord") {
    return res.redirect("/resident-login");
  }

  const landlordId = req.user.id;
  const { tenantEmail } = req.body;

  try {
    // Check if tenant exists
    const tenantResult = await db.query(
      "SELECT id FROM users WHERE email = $1 AND role = 'tenant'",
      [tenantEmail]
    );
    if (tenantResult.rows.length === 0) {
      return res.render("add-tenant", {
        error: "Tenant not found.",
        title: "Add Tenant",
        cssFile: "add-tenant.css", // Ensure you have a CSS file named accordingly
      });
    }

    const tenantId = tenantResult.rows[0].id;

    // Insert into tenant_landlord table
    await db.query(
      "INSERT INTO tenant_landlord (landlord_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [landlordId, tenantId]
    );

    res.redirect("/landlord-dashboard"); // Redirect back to the landlord dashboard or show success message
  } catch (err) {
    console.error(err);
    res.render("add-tenant", {
      error: "Tenant not found.",
      title: "Add Tenant",
      cssFile: "add-tenant.css", // Ensure you have a CSS file named accordingly
    });
  }
});

// GET route for displaying the landlord profile
app.get("/landlord-dashboard/profile", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "landlord") {
    return res.redirect("/resident-login");
  }

  try {
    const landlordId = req.user.id;
    const userQuery =
      "SELECT name, email, role, created_at FROM users WHERE id = $1";
    const userInfo = await db.query(userQuery, [landlordId]);

    res.render("landlord-profile", {
      title: "Landlord Profile Management",
      cssFile: "landlord-profile.css",
      user: userInfo.rows[0],
      error: null,
    });
  } catch (err) {
    console.error("Error fetching landlord profile:", err);
    res.redirect("/landlord-dashboard");
  }
});

// Home page
app.get("/", (req, res) => {
  res.render("home", { title: "home", cssFile: "styles.css" });
});

app.get("/resident-login", (req, res) => {
  res.render("resident-login", {
    title: "resident login",
    cssFile: "style-login.css",
  });
});

app.get("/rental-application", (req, res) => {
  res.render("rental-application", { title: "Application for rental" });
});

app.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
  })
);
// Fetch properties for the front end
app.get("/properties", async (req, res) => {
  try {
    const properties = await db.query(`SELECT * FROM properties LIMIT 6`);
    // console.log(properties.rows);
    res.json(properties.rows); // Return the data in JSON format
  } catch (err) {
    console.error("Server error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Contact us form handler
app.post("/send-email", (req, res) => {
  const { name, email, subject, category, message } = req.body;
  // Create a transporter for sending emails
  const transporter = nodemailer.createTransport({
    service: "Gmail",
    auth: {
      user: process.env.CONTACT_US_EMAIL,
      pass: process.env.CONTACT_US_PASSWORD,
    },
  });
  const mailOptions = {
    from: email,
    to: process.env.CONTACT_US_EMAIL,
    subject: `New Contact Form Submission:${category} - ${subject}`,
    text: `You have a new contact form submission: Name: ${name}
              Email: ${email}
              Subject: ${subject}
              Category: ${category}
              Message: ${message}`,
  };
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log(error);
      res.status(500).send("Error sending email");
    } else {
      console.log("Email sent: " + info.response);
      return res.redirect("/?success=true");
    }
  });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
