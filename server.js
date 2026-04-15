const express = require("express");
const cors = require("cors");
const pool = require("./db");
require("dotenv").config();

const app = express();

app.use(
  cors({
    origin: [
      "https://vandhana-scratch-card-website.vercel.app",
      "https://vandhana-scratch-card-website-m2ba.vercel.app"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true
  })
);

app.use(express.json());

const isValidName = (value) => /^[A-Za-z ]{3,}$/.test((value || "").trim());
const isValidMobile = (value) => /^[6789][0-9]{9}$/.test(value || "");
const isValidGender = (value) => ["Male", "Female", "Other"].includes(value);
const isValidMaritalStatus = (value) => ["Single", "Married"].includes(value);

app.get("/", (req, res) => {
  res.status(200).json({ message: "Vandhana backend running" });
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    return res.status(200).json({ message: "Database connected successfully" });
  } catch (error) {
    return res.status(500).json({
      message: "Database connection failed",
      error: error.message
    });
  }
});

app.post("/api/customers", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      customerName,
      mobileNumber,
      gender,
      dateOfBirth,
      maritalStatus,
      spouseName,
      spouseDob,
      hasChildren,
      shoppingPreference,
      city,
      children
    } = req.body;

    if (!isValidName(customerName)) {
      return res.status(400).json({ message: "Invalid customer name" });
    }

    if (!isValidMobile(mobileNumber)) {
      return res.status(400).json({ message: "Invalid mobile number" });
    }

    if (!isValidGender(gender)) {
      return res.status(400).json({ message: "Invalid gender" });
    }

    if (!dateOfBirth) {
      return res.status(400).json({ message: "Date of birth is required" });
    }

    if (!isValidMaritalStatus(maritalStatus)) {
      return res.status(400).json({ message: "Invalid marital status" });
    }

    if (maritalStatus === "Married") {
      if (!isValidName(spouseName)) {
        return res.status(400).json({ message: "Invalid spouse name" });
      }

      if (!spouseDob) {
        return res.status(400).json({ message: "Spouse date of birth is required" });
      }

      if (hasChildren === true) {
        if (!Array.isArray(children) || children.length === 0) {
          return res.status(400).json({ message: "Children details are required" });
        }

        for (let i = 0; i < children.length; i += 1) {
          const child = children[i];

          if (!isValidName(child.childName)) {
            return res.status(400).json({ message: `Invalid child name at row ${i + 1}` });
          }

          if (!child.childDob) {
            return res.status(400).json({ message: `Child DOB required at row ${i + 1}` });
          }
        }
      }
    }

    await client.query("BEGIN");

    const existingCustomer = await client.query(
      "SELECT id FROM customers WHERE mobile_number = $1",
      [mobileNumber]
    );

    if (existingCustomer.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Customer with this mobile number already exists" });
    }

    const insertCustomerQuery = `
      INSERT INTO customers (
        customer_name,
        mobile_number,
        gender,
        date_of_birth,
        marital_status,
        spouse_name,
        spouse_dob,
        has_children,
        shopping_preference,
        city
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id
    `;

    const customerValues = [
      customerName.trim(),
      mobileNumber,
      gender,
      dateOfBirth,
      maritalStatus,
      maritalStatus === "Married" ? spouseName?.trim() || null : null,
      maritalStatus === "Married" ? spouseDob || null : null,
      maritalStatus === "Married" ? Boolean(hasChildren) : false,
      shoppingPreference || null,
      city?.trim() || null
    ];

    const customerResult = await client.query(insertCustomerQuery, customerValues);
    const customerId = customerResult.rows[0].id;

    if (maritalStatus === "Married" && hasChildren === true && Array.isArray(children)) {
      for (const child of children) {
        await client.query(
          `
          INSERT INTO customer_children (
            customer_id,
            child_name,
            child_dob
          )
          VALUES ($1,$2,$3)
          `,
          [customerId, child.childName.trim(), child.childDob]
        );
      }
    }

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Customer data saved successfully",
      customerId
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({
      message: "Internal server error",
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.get("/api/customers", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.customer_name,
        c.mobile_number,
        c.gender,
        c.date_of_birth,
        c.marital_status,
        c.spouse_name,
        c.spouse_dob,
        c.has_children,
        c.shopping_preference,
        c.city,
        c.created_at,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', cc.id,
              'childName', cc.child_name,
              'childDob', cc.child_dob
            )
          ) FILTER (WHERE cc.id IS NOT NULL),
          '[]'
        ) AS children
      FROM customers c
      LEFT JOIN customer_children cc ON c.id = cc.customer_id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);

    return res.status(200).json(result.rows);
  } catch (error) {
    return res.status(500).json({
      message: "Failed to fetch customers",
      error: error.message
    });
  }
});

module.exports = app;

if (require.main === module) {
  app.listen(process.env.PORT || 5000, () => {
    console.log(`Server running on port ${process.env.PORT || 5000}`);
  });
}