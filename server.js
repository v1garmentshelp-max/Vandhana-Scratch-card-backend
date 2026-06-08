const express = require("express");
const cors = require("cors");
const axios = require("axios");
const pool = require("./db");
require("dotenv").config();

const app = express();

const allowedOrigins = [
  "https://vandhana-scratch-card-website.vercel.app",
  "https://vandhana-scratch-card-website-m2ba.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "http://127.0.0.1:3002",
  "http://127.0.0.1:3003",
  "http://127.0.0.1:5173"
];

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (/^http:\/\/localhost:\d+$/.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return true;
  return false;
};

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    optionsSuccessStatus: 204
  })
);

app.use(express.json());

const isValidName = (value) => /^[A-Za-z ]{3,}$/.test((value || "").trim());
const isValidMobile = (value) => /^[6789][0-9]{9}$/.test(value || "");
const isValidGender = (value) => ["Male", "Female", "Other"].includes(value);
const isValidMaritalStatus = (value) => ["Single", "Married"].includes(value);

const normalizeIndianWhatsAppNumber = (mobileNumber) => {
  const digits = String(mobileNumber || "").replace(/\D/g, "");

  if (digits.length === 10) {
    return `91${digits}`;
  }

  if (digits.startsWith("91") && digits.length === 12) {
    return digits;
  }

  return digits;
};

const sendBirthdayWhatsAppMessage = async ({ to, personName, birthdayDate }) => {
  const graphVersion = process.env.META_GRAPH_VERSION || "v25.0";
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME || "birthday_reminder";
  const templateLanguage = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en_US";

  if (!phoneNumberId) {
    throw new Error("WHATSAPP_PHONE_NUMBER_ID is missing");
  }

  if (!accessToken) {
    throw new Error("WHATSAPP_ACCESS_TOKEN is missing");
  }

  const response = await axios.post(
    `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: templateName,
        language: {
          code: templateLanguage
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: personName
              },
              {
                type: "text",
                text: birthdayDate
              }
            ]
          }
        ]
      }
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    }
  );

  return response.data;
};

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
      children,
      whatsappOptIn
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
        city,
        whatsapp_opt_in,
        whatsapp_opt_in_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
      city?.trim() || null,
      Boolean(whatsappOptIn),
      whatsappOptIn ? new Date() : null
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
        c.whatsapp_opt_in,
        c.whatsapp_opt_in_at,
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

app.post("/api/whatsapp/test-birthday-template", async (req, res) => {
  try {
    const { mobileNumber, name, birthdayDate } = req.body;

    if (!mobileNumber) {
      return res.status(400).json({ message: "mobileNumber is required" });
    }

    const whatsappNumber = normalizeIndianWhatsAppNumber(mobileNumber);

    const metaResponse = await sendBirthdayWhatsAppMessage({
      to: whatsappNumber,
      personName: name || "Ravi",
      birthdayDate: birthdayDate || "25 June"
    });

    return res.status(200).json({
      message: "WhatsApp birthday template sent successfully",
      to: whatsappNumber,
      metaResponse
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to send WhatsApp template",
      error: error.response?.data || error.message
    });
  }
});

app.get("/api/cron/send-birthday-whatsapp", async (req, res) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization || "";

    if (
      cronSecret &&
      authHeader !== `Bearer ${cronSecret}` &&
      req.query.secret !== cronSecret
    ) {
      return res.status(401).json({ message: "Unauthorized cron request" });
    }

    const daysBefore = Number(process.env.BIRTHDAY_REMINDER_DAYS_BEFORE || 7);

    const duePeople = await pool.query(
      `
      WITH target AS (
        SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + ($1::int * INTERVAL '1 day'))::date AS target_date
      )

      SELECT
        c.id AS customer_id,
        c.id AS person_ref_id,
        'customer' AS person_type,
        c.customer_name AS person_name,
        c.mobile_number,
        t.target_date,
        TO_CHAR(t.target_date, 'DD Mon YYYY') AS target_date_label
      FROM customers c
      CROSS JOIN target t
      WHERE c.whatsapp_opt_in = TRUE
        AND c.date_of_birth IS NOT NULL
        AND EXTRACT(MONTH FROM c.date_of_birth) = EXTRACT(MONTH FROM t.target_date)
        AND EXTRACT(DAY FROM c.date_of_birth) = EXTRACT(DAY FROM t.target_date)
        AND NOT EXISTS (
          SELECT 1
          FROM birthday_message_logs l
          WHERE l.person_type = 'customer'
            AND l.person_ref_id = c.id
            AND l.target_date = t.target_date
            AND l.status = 'sent'
        )

      UNION ALL

      SELECT
        c.id AS customer_id,
        c.id AS person_ref_id,
        'spouse' AS person_type,
        c.spouse_name AS person_name,
        c.mobile_number,
        t.target_date,
        TO_CHAR(t.target_date, 'DD Mon YYYY') AS target_date_label
      FROM customers c
      CROSS JOIN target t
      WHERE c.whatsapp_opt_in = TRUE
        AND c.marital_status = 'Married'
        AND c.spouse_name IS NOT NULL
        AND c.spouse_dob IS NOT NULL
        AND EXTRACT(MONTH FROM c.spouse_dob) = EXTRACT(MONTH FROM t.target_date)
        AND EXTRACT(DAY FROM c.spouse_dob) = EXTRACT(DAY FROM t.target_date)
        AND NOT EXISTS (
          SELECT 1
          FROM birthday_message_logs l
          WHERE l.person_type = 'spouse'
            AND l.person_ref_id = c.id
            AND l.target_date = t.target_date
            AND l.status = 'sent'
        )

      UNION ALL

      SELECT
        c.id AS customer_id,
        cc.id AS person_ref_id,
        'child' AS person_type,
        cc.child_name AS person_name,
        c.mobile_number,
        t.target_date,
        TO_CHAR(t.target_date, 'DD Mon YYYY') AS target_date_label
      FROM customer_children cc
      JOIN customers c ON c.id = cc.customer_id
      CROSS JOIN target t
      WHERE c.whatsapp_opt_in = TRUE
        AND cc.child_dob IS NOT NULL
        AND EXTRACT(MONTH FROM cc.child_dob) = EXTRACT(MONTH FROM t.target_date)
        AND EXTRACT(DAY FROM cc.child_dob) = EXTRACT(DAY FROM t.target_date)
        AND NOT EXISTS (
          SELECT 1
          FROM birthday_message_logs l
          WHERE l.person_type = 'child'
            AND l.person_ref_id = cc.id
            AND l.target_date = t.target_date
            AND l.status = 'sent'
        )
      `,
      [daysBefore]
    );

    const results = [];

    for (const person of duePeople.rows) {
      const whatsappNumber = normalizeIndianWhatsAppNumber(person.mobile_number);

      try {
        const metaResponse = await sendBirthdayWhatsAppMessage({
          to: whatsappNumber,
          personName: person.person_name,
          birthdayDate: person.target_date_label
        });

        await pool.query(
          `
          INSERT INTO birthday_message_logs (
            customer_id,
            person_type,
            person_ref_id,
            person_name,
            mobile_number,
            target_date,
            status,
            meta_response,
            sent_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
          ON CONFLICT (person_type, person_ref_id, target_date)
          DO UPDATE SET
            status = EXCLUDED.status,
            meta_response = EXCLUDED.meta_response,
            error_message = NULL,
            sent_at = NOW()
          `,
          [
            person.customer_id,
            person.person_type,
            person.person_ref_id,
            person.person_name,
            whatsappNumber,
            person.target_date,
            "sent",
            metaResponse
          ]
        );

        results.push({
          personType: person.person_type,
          personName: person.person_name,
          mobileNumber: whatsappNumber,
          birthdayDate: person.target_date_label,
          status: "sent"
        });
      } catch (error) {
        const errorMessage = error.response?.data
          ? JSON.stringify(error.response.data)
          : error.message;

        await pool.query(
          `
          INSERT INTO birthday_message_logs (
            customer_id,
            person_type,
            person_ref_id,
            person_name,
            mobile_number,
            target_date,
            status,
            error_message,
            sent_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
          ON CONFLICT (person_type, person_ref_id, target_date)
          DO UPDATE SET
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            sent_at = NOW()
          `,
          [
            person.customer_id,
            person.person_type,
            person.person_ref_id,
            person.person_name,
            whatsappNumber,
            person.target_date,
            "failed",
            errorMessage
          ]
        );

        results.push({
          personType: person.person_type,
          personName: person.person_name,
          mobileNumber: whatsappNumber,
          birthdayDate: person.target_date_label,
          status: "failed",
          error: errorMessage
        });
      }
    }

    return res.status(200).json({
      message: "Birthday WhatsApp reminders processed",
      daysBefore,
      totalDue: duePeople.rows.length,
      results
    });
  } catch (error) {
    return res.status(500).json({
      message: "Birthday WhatsApp cron failed",
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