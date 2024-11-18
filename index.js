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
