require("dotenv").config(); // ✅ MUST be first — loads env vars before anything uses them

const express    = require("express");
const mongoose   = require("mongoose");
const multer     = require("multer");
const cors       = require("cors");
const path       = require("path");
const fs         = require("fs");
const { Parser } = require("json2csv");
const archiver   = require("archiver");
const PDFDocument = require("pdfkit");

const app  = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use(express.static(path.join(__dirname, "public")));

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e6);
    cb(null, unique + path.extname(file.originalname));
  },
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith("image/")) cb(null, true);
  else cb(new Error("Only image files are allowed."), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per photo
});

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("✅ MongoDB Connected");

    // ── Seed all-time lifetime counter ──────────────────────────────────────
    // On first run, count existing "done" orders so the number is not 0.
    // After this, only the everDone flag controls increments.
    const existingCounter = await Counter.findById("processed");
    if (!existingCounter) {
      const doneCount = await Order.countDocuments({ status: "done" });
      await Counter.create({ _id: "processed", value: doneCount });
      console.log(`✅ Lifetime counter seeded at ${doneCount}`);
    }

    // ── Seed per-page permanent counters ────────────────────────────────────
    // On first run, build PageCounter from existing done orders so history
    // is not lost on upgrade. After this, only everDone transitions add to it.
    const existingPages = await PageCounter.countDocuments();
    if (existingPages === 0) {
      const pageGroups = await Order.aggregate([
        { $match: { status: "done" } },
        { $group: { _id: "$fbPage", count: { $sum: 1 } } },
      ]);
      if (pageGroups.length > 0) {
        await PageCounter.insertMany(pageGroups.map(g => ({ _id: g._id, count: g.count })));
        console.log(`✅ Per-page counters seeded for ${pageGroups.length} page(s)`);
      }
    }

    // ── Backfill everDone on existing done orders ────────────────────────────
    // Any orders already marked "done" before this update don't have everDone=true.
    // Set it now so they are recognised as already-counted and won't double-count.
    const backfilled = await Order.updateMany(
      { status: "done", everDone: { $ne: true } },
      { $set: { everDone: true } }
    );
    if (backfilled.modifiedCount > 0) {
      console.log(`✅ Backfilled everDone=true on ${backfilled.modifiedCount} existing done order(s)`);
    }

    // ── Seed gender counters ─────────────────────────────────────────────────
    // On first run, count existing orders by gender so history is preserved.
    const maleDoc = await GenderCounter.findById("male");
    const femaleDoc = await GenderCounter.findById("female");
    if (!maleDoc) {
      const maleCount = await Order.countDocuments({ gender: "male" });
      await GenderCounter.create({ _id: "male", count: maleCount });
      console.log(`✅ Gender counter seeded: male=${maleCount}`);
    }
    if (!femaleDoc) {
      const femaleCount = await Order.countDocuments({ gender: "female" });
      await GenderCounter.create({ _id: "female", count: femaleCount });
      console.log(`✅ Gender counter seeded: female=${femaleCount}`);
    }
  })
  .catch((err) => console.log("❌ MongoDB Error:", err));

const photoSchema = new mongoose.Schema({
  filename:     { type: String, required: true },
  originalName: { type: String },
  url:          { type: String, required: true },
});

const orderSchema = new mongoose.Schema(
  {
    categoryId:    { type: String, required: true },
    categoryName:  { type: String, required: true },
    categoryPrice: { type: String, required: true },
    fullName:      { type: String, required: true, trim: true },
    phone:         { type: String, required: true, trim: true },
    gender:        { type: String, enum: ["male", "female"], required: true },
    specialName:   { type: String, required: true, trim: true },
    specialDate:   { type: String, required: true },
    fbPage:        { type: String, required: true, trim: true },
    message:       { type: String, required: true, trim: true },
    photos:        [photoSchema],
    status: {
      type:    String,
      enum:    ["pending", "confirmed", "done"],
      default: "pending",
    },

    // everDone: set true the FIRST time this order reaches "done".
    // NEVER reset back to false on revert. This is the duplicate-count guard.
    // Counters only increment when everDone flips false → true.
    everDone: {
      type:    Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    collection: "orders",
  }
);

const Order = mongoose.model("Order", orderSchema);

// ── Lifetime processed counter ──────────────────────────────────────────────
// Single document { _id: "processed", value: N } — only ever increments.
// Never touched on order deletion. True all-time "frames delivered" total.
const counterSchema = new mongoose.Schema({
  _id:   { type: String, required: true },
  value: { type: Number, default: 0 },
});
const Counter = mongoose.model("Counter", counterSchema, "counters");

// ── Permanent per-page completed-order counter ───────────────────────────────
// One document per Facebook page: { _id: "PageName", count: N }
// Only ever increments when everDone flips false → true.
// Survives order deletions — the leaderboard bars NEVER go backwards.
const pageCounterSchema = new mongoose.Schema({
  _id:   { type: String, required: true },  // Facebook page name is the key
  count: { type: Number, default: 0 },
});
const PageCounter = mongoose.model("PageCounter", pageCounterSchema, "page_counters");

// ── Permanent gender counter ─────────────────────────────────────────────────
// Two documents: { _id: "male", count: N } and { _id: "female", count: N }
// Counts total orders (not just done) by gender — permanent, never decremented.
const genderCounterSchema = new mongoose.Schema({
  _id:   { type: String, required: true },
  count: { type: Number, default: 0 },
});
const GenderCounter = mongoose.model("GenderCounter", genderCounterSchema, "gender_counters");

// ── Sales Record table ───────────────────────────────────────────────────────
// One document per order — stores all text data (no images).
// The last field "totalSales" is always the cumulative running total of ALL
// frame prices ever recorded. It is recalculated and persisted on every insert
// so a simple sort by createdAt gives a running-total ledger.
// This collection is NEVER exposed to the admin UI — only downloaded as a PDF
// behind a separate password.
const salesRecordSchema = new mongoose.Schema(
  {
    orderId:       { type: String, required: true, unique: true },
    submittedAt:   { type: Date,   required: true },
    status:        { type: String },
    fullName:      { type: String },
    phone:         { type: String },
    gender:        { type: String },
    specialName:   { type: String },
    fbPage:        { type: String },
    specialDate:   { type: String },
    frameName:     { type: String },
    framePrice:    { type: String },
    framePriceNum: { type: Number, default: 0 },
    message:       { type: String },
    totalSales:    { type: Number, default: 0 }, // cumulative sum up to & including this row
  },
  { collection: "sales_records" }
);
const SalesRecord = mongoose.model("SalesRecord", salesRecordSchema);

app.post("/api/orders", upload.array("photos", 20), async (req, res) => {
  try {
    const { categoryId, categoryName, categoryPrice, fullName, phone, gender, specialName, fbPage, specialDate, message } = req.body;

    if (!categoryId || !fullName || !phone || !fbPage || !specialDate || !message || !gender || !specialName) {
      return res.status(400).json({ success: false, message: "All fields are required." });
    }
    if (!["male", "female"].includes(gender)) {
      return res.status(400).json({ success: false, message: "Invalid gender value." });
    }
    if (!/^\d{7,15}$/.test(phone)) {
      return res.status(400).json({ success: false, message: "Invalid phone number." });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: "At least one photo is required." });
    }

    const photos = req.files.map((f) => ({
      filename:     f.filename,
      originalName: f.originalname,
      url:          `${BASE_URL}/uploads/${f.filename}`,
    }));

    const order = new Order({
      categoryId, categoryName, categoryPrice,
      fullName, phone, gender, specialName, fbPage, specialDate, message, photos,
    });

    await order.save();

    // ── Write to permanent sales ledger ────────────────────────────────────
    // Parse numeric price (strips currency symbols / Bengali characters)
    const framePriceNum = parseFloat(String(categoryPrice || "").replace(/[^\d.]/g, "")) || 0;
    // Running total = sum of all previous records + this order's price
    const lastRecord = await SalesRecord.findOne().sort({ submittedAt: -1 });
    const prevTotal  = lastRecord ? lastRecord.totalSales : 0;
    await SalesRecord.create({
      orderId:       order._id.toString(),
      submittedAt:   order.createdAt || new Date(),
      status:        "pending",
      fullName,
      phone,
      gender,
      specialName,
      fbPage,
      specialDate,
      frameName:     categoryName,
      framePrice:    categoryPrice,
      framePriceNum,
      message,
      totalSales:    prevTotal + framePriceNum,
    });

    // Increment permanent gender counter
    await GenderCounter.findByIdAndUpdate(
      gender,
      { $inc: { count: 1 } },
      { upsert: true, new: true }
    );

    res.status(201).json({
      success: true,
      message: "Order placed successfully!",
      orderId: order._id,
    });
  } catch (err) {
    console.error("POST /api/orders error:", err);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/orders", async (req, res) => {
  try {
    const { status, search } = req.query;
    const filter = {};

    if (status && ["pending", "confirmed", "done"].includes(status)) {
      filter.status = status;
    }

    if (search) {
      const rx = new RegExp(search, "i");
      filter.$or = [{ fullName: rx }, { phone: rx }, { categoryName: rx }];
    }

    const orders = await Order.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, orders });
  } catch (err) {
    console.error("GET /api/orders error:", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.get("/api/orders/stats", async (req, res) => {
  try {
    const [total, pending, confirmed, done] = await Promise.all([
      Order.countDocuments(),
      Order.countDocuments({ status: "pending" }),
      Order.countDocuments({ status: "confirmed" }),
      Order.countDocuments({ status: "done" }),
    ]);
    res.json({ success: true, stats: { total, pending, confirmed, done } });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.get("/api/stats/processed", async (req, res) => {
  try {
    const doc = await Counter.findById("processed");
    res.json({ success: true, processed: doc ? doc.value : 0 });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.get("/api/stats/pages", async (req, res) => {
  try {
    // Use the permanent PageCounter collection, not a live aggregation on orders.
    // This means counts are preserved even after orders are deleted.
    const pages = await PageCounter.find().sort({ count: -1 }).lean();
    // Reshape to match the same { _id, count } format the frontend expects
    res.json({ success: true, pages });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.get("/api/stats/gender", async (req, res) => {
  try {
    const [maleDoc, femaleDoc] = await Promise.all([
      GenderCounter.findById("male"),
      GenderCounter.findById("female"),
    ]);
    res.json({
      success: true,
      male:   maleDoc   ? maleDoc.count   : 0,
      female: femaleDoc ? femaleDoc.count : 0,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.patch("/api/orders/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["pending", "confirmed", "done"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status." });
    }
    // Fetch current status before updating so we know if this is a new "done"
    const existing = await Order.findById(req.params.id).select("status everDone fbPage");
    if (!existing) return res.status(404).json({ success: false, message: "Order not found." });

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    // Only increment counters the very first time this order ever reaches "done".
    // We use the everDone flag (never reset on revert) as the guard.
    // This prevents: done → revert → done from counting as 2 completed orders.
    if (status === "done" && !existing.everDone) {
      // Mark the order as ever-done (permanent, survives future reverts)
      await Order.findByIdAndUpdate(req.params.id, { everDone: true });

      // Increment the all-time lifetime processed counter
      await Counter.findByIdAndUpdate(
        "processed",
        { $inc: { value: 1 } },
        { upsert: true, new: true }
      );

      // Increment the permanent per-page counter for this order's FB page
      const pageName = existing.fbPage || order.fbPage || "Unknown";
      await PageCounter.findByIdAndUpdate(
        pageName,
        { $inc: { count: 1 } },
        { upsert: true, new: true }
      );
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// ✅ IMPORTANT: This route MUST come before DELETE /:id — otherwise "done" is matched as :id
app.delete("/api/orders/done/all", async (req, res) => {
  try {
    const donOrders = await Order.find({ status: "done" });

    donOrders.forEach((o) =>
      o.photos.forEach((p) => {
        const fp = path.join(__dirname, "uploads", p.filename);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      })
    );

    const result = await Order.deleteMany({ status: "done" });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.delete("/api/orders/:id", async (req, res) => {
  try {
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });

    order.photos.forEach((p) => {
      const fp = path.join(__dirname, "uploads", p.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    });

    res.json({ success: true, message: "Order deleted." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.get("/api/orders/export/csv", async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 }).lean();

    const rows = orders.map((o) => {
      // Extract numeric price value for total sales calculation
      const priceNum = parseFloat(String(o.categoryPrice || "").replace(/[^\d.]/g, "")) || 0;
      return {
        "Order ID":      o._id.toString(),
        "Submitted At":  o.createdAt ? new Date(o.createdAt).toLocaleString() : "",
        "Status":        o.status,
        "Frame":         o.categoryName,
        "Price":         o.categoryPrice,
        "Price (Numeric)": priceNum,
        "Full Name":     o.fullName,
        "Gender":        o.gender === "male" ? "Male (পুরুষ)" : o.gender === "female" ? "Female (মহিলা)" : (o.gender || "—"),
        "Frame Display Name": o.specialName || "—",
        "Phone":         o.phone,
        "Facebook Page": o.fbPage || "—",
        "Special Date":  o.specialDate,
        "Message":       o.message,
        "Photo Count":   o.photos.length,
        "Photo URLs":    o.photos.map((p) => `${BASE_URL}${p.url}`).join(" | "),
      };
    });

    // Append a totals summary row
    const totalSales = rows.reduce((sum, r) => sum + (r["Price (Numeric)"] || 0), 0);
    const maleCount   = rows.filter(r => r["Gender"].startsWith("Male")).length;
    const femaleCount = rows.filter(r => r["Gender"].startsWith("Female")).length;
    rows.push({
      "Order ID":      "— SUMMARY —",
      "Submitted At":  `Total Orders: ${orders.length}`,
      "Status":        "",
      "Frame":         `Total Sales: ৳ ${totalSales.toLocaleString()}`,
      "Price":         "",
      "Price (Numeric)": totalSales,
      "Full Name":     "",
      "Gender":        `Male: ${maleCount} | Female: ${femaleCount}`,
      "Frame Display Name": "",
      "Phone":         "",
      "Facebook Page": "",
      "Special Date":  "",
      "Message":       "",
      "Photo Count":   "",
      "Photo URLs":    "",
    });

    const parser = new Parser({ fields: Object.keys(rows[0] || {}) });
    const csv    = parser.parse(rows);
    const date   = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="alishan-moments-orders-${date}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, message: "Export failed." });
  }
});

app.get("/api/orders/export/csv/:id", async (req, res) => {
  try {
    const o = await Order.findById(req.params.id).lean();
    if (!o) return res.status(404).json({ success: false, message: "Order not found." });

    const rows = [{
      "Order ID":     o._id.toString(),
      "Submitted At": o.createdAt ? new Date(o.createdAt).toLocaleString() : "",
      "Status":       o.status,
      "Frame":        o.categoryName,
      "Price":        o.categoryPrice,
      "Full Name":    o.fullName,
      "Phone":        o.phone,
      "Special Date": o.specialDate,
      "Message":      o.message,
      "Photo Count":  o.photos.length,
      "Photo URLs": o.photos.map((p) => `${BASE_URL}${p.url}`).join(" | "),
    }];

    const parser = new Parser({ fields: Object.keys(rows[0]) });
    const csv    = parser.parse(rows);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="order-${o._id}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, message: "Export failed." });
  }
});

app.get("/api/orders/export/zip/:id", async (req, res) => {
  try {
    const o = await Order.findById(req.params.id).lean();
    if (!o) return res.status(404).json({ success: false, message: "Order not found." });

    const safeName   = o.fullName.replace(/[^a-z0-9]/gi, "_");
    const zipName    = `order_${safeName}_${o._id.toString().slice(-6)}.zip`;
    const submittedAt = o.createdAt ? new Date(o.createdAt).toLocaleString("en-GB", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" }) : "—";
    const specialDate = o.specialDate ? new Date(o.specialDate + "T00:00:00").toLocaleDateString("en-GB", { day:"2-digit", month:"long", year:"numeric" }) : "—";

    // Generate PDF
    const pdfBuffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      doc.on("data", chunk => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const INK    = "#1a1612";
      const GOLD   = "#b8873a";
      const MUTED  = "#888880";
      const WHITE  = "#ffffff";
      const CREAM  = "#f5f0e8";
      const W      = doc.page.width - 100; 

      doc.rect(50, 50, W, 70).fill(INK);
      doc.fontSize(18).fillColor(GOLD).font("Helvetica-Bold")
         .text("Memory Frames", 65, 65);
      doc.fontSize(8).fillColor("#cccccc").font("Helvetica")
         .text(submittedAt, 65, 90);
      const statusColors = { pending: "#d4813a", confirmed: "#6a9c7a", done: "#888880" };
      doc.fontSize(8).fillColor(statusColors[o.status] || GOLD).font("Helvetica-Bold")
         .text(o.status.toUpperCase(), W - 30, 75, { align: "right", width: 80 });
      doc.fontSize(6).fillColor("#888888").font("Helvetica")
         .text("ID: " + o._id.toString(), W - 100, 90, { align: "right", width: 150 });

      let y = 140;

      function sectionTitle(title) {
        doc.rect(50, y, W, 24).fill(CREAM);
        doc.fontSize(10).fillColor(INK).font("Helvetica-Bold")
           .text(title, 60, y + 7);
        y += 30;
      }

      function field(label, value) {
        if (y > 750) { doc.addPage(); y = 50; }
        doc.fontSize(7).fillColor(MUTED).font("Helvetica-Bold")
           .text(label.toUpperCase(), 60, y, { width: 130 });
        doc.fontSize(9).fillColor(INK).font("Helvetica")
           .text(String(value || "—"), 200, y, { width: W - 150 });
        y += 18;
        doc.moveTo(50, y - 1).lineTo(50 + W, y - 1).strokeColor("#e8e0d0").lineWidth(0.5).stroke();
      }

      sectionTitle("Customer Information");
      field("Full Name",     o.fullName);
      field("Phone",         o.phone);
      field("Facebook Page", o.fbPage || "—");
      y += 10;

      sectionTitle("Frame Details");
      field("Frame Type",   o.categoryName);
      field("Price",        "Tk. " + String(o.categoryPrice || "").replace(/[^\x00-\x7F0-9.,\s]/g, "").trim());
      field("Special Date", specialDate);
      y += 10;

      sectionTitle("Personal Message");
      if (y > 700) { doc.addPage(); y = 50; }
      doc.rect(50, y, W, 1).fill(CREAM);
      doc.fontSize(9).fillColor(INK).font("Helvetica")
         .text(o.message || "—", 60, y + 8, { width: W - 20, lineGap: 4 });
      y += doc.heightOfString(o.message || "—", { width: W - 20 }) + 24;

      if (o.photos && o.photos.length) {
        y += 5;
        sectionTitle(`Uploaded Photos (${o.photos.length})`);
        o.photos.forEach((p, i) => {
          if (y > 750) { doc.addPage(); y = 50; }
          doc.fontSize(8).fillColor(MUTED).font("Helvetica-Bold")
             .text(`Photo ${i + 1}`, 60, y, { width: 60 });
          doc.fontSize(8).fillColor(INK).font("Helvetica")
             .text(p.originalName || p.filename, 130, y, { width: W - 90 });
          y += 16;
        });
      }

      const footerY = doc.page.height - 40;
      doc.fontSize(7).fillColor(MUTED).font("Helvetica")
         .text(
           `Generated by Memory Frames Admin Panel  ·  ${new Date().toLocaleDateString("en-GB", { day:"2-digit", month:"long", year:"numeric" })}`,
           50, footerY, { align: "center", width: W }
         );

      doc.end();
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => { throw err; });
    archive.pipe(res);

    archive.append(pdfBuffer, { name: "order-details.pdf" });

    o.photos.forEach((p) => {
      const filePath = path.join(__dirname, "uploads", p.filename);
      if (fs.existsSync(filePath)) {
        const photoName = `photos/photo_${(p.originalName || p.filename).replace(/[^a-z0-9._-]/gi, "_")}`;
        archive.file(filePath, { name: photoName });
      }
    });

    await archive.finalize();

  } catch (err) {
    console.error("ZIP export error:", err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "Export failed." });
    }
  }
});

// ── Sales Ledger PDF export (password-protected) ─────────────────────────────
app.post("/api/orders/export/sales-pdf", async (req, res) => {
  try {
    const { password } = req.body;
    const SALES_PASSWORD = process.env.SALES_PDF_PASSWORD || "alishan@sales2026";
    if (!password || password !== SALES_PASSWORD) {
      return res.status(401).json({ success: false, message: "Invalid password." });
    }

    const records = await SalesRecord.find().sort({ submittedAt: 1 }).lean();
    const date    = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });

    // ── Group records by Facebook page ────────────────────────────────────────
    const pageMap = new Map(); // pageName → [records]
    records.forEach(r => {
      const page = (r.fbPage || "Unknown Page").trim();
      if (!pageMap.has(page)) pageMap.set(page, []);
      pageMap.get(page).push(r);
    });
    const pages = [...pageMap.entries()]; // [ [pageName, [records]], ... ]

    // Grand total across all pages
    const grandTotal = records.reduce((s, r) => s + (r.framePriceNum || 0), 0);

    const pdfBuffer = await new Promise((resolve, reject) => {
      const doc    = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: true });
      const chunks = [];
      doc.on("data",  c  => chunks.push(c));
      doc.on("end",   () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // ── Palette & layout constants ────────────────────────────────────────
      const INK     = "#0d0b09";
      const GOLD    = "#b8873a";
      const GOLD_LT = "#d4a85a";
      const CREAM   = "#f5f0e8";
      const MUTED   = "#7a7570";
      const WHITE   = "#ffffff";
      const ROW_A   = "#faf7f2";
      const BORDER  = "#e0d8cc";

      const PAGE_W  = doc.page.width;   // 595.28
      const PAGE_H  = doc.page.height;  // 841.89
      const ML      = 40;
      const CW      = PAGE_W - ML * 2;
      const FOOTER_H = 34;
      const SAFE_H  = PAGE_H - FOOTER_H - 10; // lowest y before footer zone

      // ── Column layout (4 data columns) ───────────────────────────────────
      //  #  | Customer Name  | Phone  | Frame / Order Type  | Amount (Tk.)
      const COL = [
        { h: "#",                w: 28,  al: "center" },
        { h: "Customer Name",    w: 160, al: "left"   },
        { h: "Phone",            w: 90,  al: "left"   },
        { h: "Order Type",       w: 180, al: "left"   },
        { h: "Amount (Tk.)",     w: 65,  al: "right"  },
      ];
      // Pre-compute x positions
      let _cx = ML;
      COL.forEach(c => { c.x = _cx; _cx += c.w; });

      const ROW_H    = 19;
      const HEAD_H   = 17;
      const SUB_H    = 19;

      // ── Helpers ──────────────────────────────────────────────────────────
      let y = 0;
      let pageNum = 0;

      function newPage() {
        if (pageNum > 0) doc.addPage({ size: "A4", margin: 0 });
        pageNum++;
        y = 0;
        drawPageHeader();
      }

      function drawPageHeader() {
        // Dark bar at top
        doc.rect(0, 0, PAGE_W, 72).fill(INK);
        doc.font("Helvetica-Bold").fontSize(18).fillColor(GOLD)
           .text("Alishan Moments", ML, 18, { width: CW * 0.55 });
        doc.font("Helvetica").fontSize(7.5).fillColor("#aaa9a6")
           .text("Confidential Sales Ledger  ·  Internal Use Only", ML, 42, { width: CW * 0.55 });
        doc.font("Helvetica").fontSize(7).fillColor("#aaa9a6")
           .text(`Generated: ${date}`, ML, 18, { width: CW, align: "right" });
        doc.font("Helvetica-Bold").fontSize(8).fillColor(GOLD_LT)
           .text(
             `${records.length} order${records.length !== 1 ? "s" : ""}   ·   Grand Total: Tk. ${grandTotal.toLocaleString("en-IN")}`,
             ML, 32, { width: CW, align: "right" }
           );
        // Gold underline
        doc.moveTo(0, 72).lineTo(PAGE_W, 72).lineWidth(2).strokeColor(GOLD).stroke();
        y = 84;
      }

      function drawFooter() {
        const fy = PAGE_H - FOOTER_H;
        doc.moveTo(ML, fy).lineTo(ML + CW, fy).lineWidth(0.5).strokeColor(GOLD).stroke();
        doc.font("Helvetica").fontSize(6.5).fillColor(MUTED)
           .text("Alishan Moments  ·  Confidential — Authorized Personnel Only", ML, fy + 7, { width: CW * 0.6 });
        doc.font("Helvetica").fontSize(6.5).fillColor(MUTED)
           .text(`Page ${pageNum}  ·  ${date}`, ML, fy + 7, { width: CW, align: "right" });
      }

      function goldRule(yy, thick = 0.8) {
        doc.moveTo(ML, yy).lineTo(ML + CW, yy).lineWidth(thick).strokeColor(GOLD).stroke();
      }

      function ensureSpace(needed) {
        if (y + needed > SAFE_H) {
          drawFooter();
          newPage();
        }
      }

      function drawTableHeader() {
        doc.rect(ML, y, CW, HEAD_H).fill(INK);
        COL.forEach(c => {
          doc.font("Helvetica-Bold").fontSize(7).fillColor(GOLD_LT)
             .text(c.h, c.x + 4, y + 4, { width: c.w - 8, align: c.al });
        });
        y += HEAD_H;
      }

      function drawRow(idx, name, phone, orderType, amount) {
        const bg = idx % 2 === 0 ? ROW_A : WHITE;
        doc.rect(ML, y, CW, ROW_H).fill(bg);
        const cells = [
          { v: String(idx + 1), ...COL[0] },
          { v: name,             ...COL[1] },
          { v: phone,            ...COL[2] },
          { v: orderType,        ...COL[3] },
          { v: amount > 0 ? amount.toLocaleString("en-IN") : "—", ...COL[4] },
        ];
        cells.forEach(cell => {
          const isAmt = cell.h === "Amount (Tk.)";
          doc.font(isAmt ? "Helvetica-Bold" : "Helvetica")
             .fontSize(7.5)
             .fillColor(isAmt ? GOLD : INK)
             .text(cell.v, cell.x + 4, y + 5, { width: cell.w - 8, align: cell.al, lineBreak: false });
        });
        doc.moveTo(ML, y + ROW_H).lineTo(ML + CW, y + ROW_H)
           .lineWidth(0.25).strokeColor(BORDER).stroke();
        y += ROW_H;
      }

      function drawSubtotal(pageName, subtotal, count) {
        ensureSpace(SUB_H + 6);
        doc.rect(ML, y, CW, SUB_H).fill(CREAM);
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED)
           .text(`Subtotal — ${pageName}  (${count} order${count !== 1 ? "s" : ""})`,
                 ML + 4, y + 5, { width: CW * 0.7 });
        doc.font("Helvetica-Bold").fontSize(9).fillColor(GOLD)
           .text(`Tk. ${subtotal.toLocaleString("en-IN")}`, ML + 4, y + 4, { width: CW - 8, align: "right" });
        goldRule(y + SUB_H, 0.5);
        y += SUB_H + 6;
      }

      // ── START RENDERING ───────────────────────────────────────────────────
      newPage();

      // Summary stat strip just below the header
      const statBoxW = CW / 3;
      const maleCount   = records.filter(r => r.gender === "male").length;
      const femaleCount = records.filter(r => r.gender === "female").length;
      const statItems = [
        { label: "Total Orders",     value: String(records.length) },
        { label: "Male / Female",    value: `${maleCount} / ${femaleCount}` },
        { label: "Facebook Pages",   value: String(pages.length) },
      ];
      doc.rect(ML, y, CW, 38).fill(CREAM);
      statItems.forEach((s, i) => {
        const bx = ML + i * statBoxW;
        if (i > 0) doc.moveTo(bx, y + 6).lineTo(bx, y + 32).lineWidth(0.4).strokeColor(BORDER).stroke();
        doc.font("Helvetica").fontSize(6.5).fillColor(MUTED)
           .text(s.label.toUpperCase(), bx + 8, y + 7, { width: statBoxW - 14 });
        doc.font("Helvetica-Bold").fontSize(13).fillColor(INK)
           .text(s.value, bx + 8, y + 17, { width: statBoxW - 14 });
      });
      goldRule(y + 38, 0.5);
      y += 46;

      // ── Per-page sections ─────────────────────────────────────────────────
      pages.forEach(([pageName, recs], pageIdx) => {
        const pageSubtotal = recs.reduce((s, r) => s + (r.framePriceNum || 0), 0);

        // Page section heading — needs heading + header + at least 1 row space
        ensureSpace(26 + HEAD_H + ROW_H);

        // Section title (page name as header)
        doc.rect(ML, y, CW, 22).fill(INK);
        // Left accent bar
        doc.rect(ML, y, 4, 22).fill(GOLD);
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(WHITE)
           .text(pageName, ML + 12, y + 6, { width: CW * 0.65 });
        doc.font("Helvetica").fontSize(7).fillColor(GOLD_LT)
           .text(`${recs.length} order${recs.length !== 1 ? "s" : ""}`, ML + 4, y + 6, { width: CW - 8, align: "right" });
        y += 22;

        // Column headers
        drawTableHeader();

        // Data rows
        recs.forEach((r, idx) => {
          ensureSpace(ROW_H);
          // If we had to break, re-draw the column header
          const prevY = y;
          if (y === 84) drawTableHeader(); // fresh page after ensureSpace
          drawRow(
            idx,
            r.fullName    || "—",
            r.phone       || "—",
            r.frameName   || "—",
            r.framePriceNum || 0
          );
        });

        // Subtotal row for this page
        drawSubtotal(pageName, pageSubtotal, recs.length);

        // Gap between page sections
        y += 8;
      });

      // ── Grand Total table ─────────────────────────────────────────────────
      ensureSpace(22 + HEAD_H + pages.length * ROW_H + 30);

      // Section title
      doc.rect(ML, y, CW, 22).fill(INK);
      doc.rect(ML, y, 4, 22).fill(GOLD);
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(GOLD)
         .text("Summary — Total Sales by Page", ML + 12, y + 6, { width: CW });
      y += 22;

      // Summary table header
      const SCOL = [
        { h: "#",              w: 28,  al: "center", x: ML },
        { h: "Facebook Page",  w: 290, al: "left",   x: ML + 28 },
        { h: "Orders",         w: 60,  al: "center", x: ML + 318 },
        { h: "Total (Tk.)",    w: 145, al: "right",  x: ML + 378 },
      ];
      doc.rect(ML, y, CW, HEAD_H).fill("#1a1612");
      SCOL.forEach(c => {
        doc.font("Helvetica-Bold").fontSize(7).fillColor(GOLD_LT)
           .text(c.h, c.x + 4, y + 4, { width: c.w - 8, align: c.al });
      });
      y += HEAD_H;

      let summaryRunning = 0;
      pages.forEach(([pageName, recs], idx) => {
        const sub = recs.reduce((s, r) => s + (r.framePriceNum || 0), 0);
        summaryRunning += sub;
        ensureSpace(ROW_H);
        const bg = idx % 2 === 0 ? ROW_A : WHITE;
        doc.rect(ML, y, CW, ROW_H).fill(bg);
        const sCells = [
          { v: String(idx + 1),                                     ...SCOL[0] },
          { v: pageName,                                             ...SCOL[1] },
          { v: String(recs.length),                                  ...SCOL[2] },
          { v: sub > 0 ? sub.toLocaleString("en-IN") : "0",         ...SCOL[3] },
        ];
        sCells.forEach(cell => {
          const isAmt = cell.h === "Total (Tk.)";
          doc.font(isAmt ? "Helvetica-Bold" : "Helvetica")
             .fontSize(7.5)
             .fillColor(isAmt ? GOLD : INK)
             .text(cell.v, cell.x + 4, y + 5, { width: cell.w - 8, align: cell.al, lineBreak: false });
        });
        doc.moveTo(ML, y + ROW_H).lineTo(ML + CW, y + ROW_H)
           .lineWidth(0.25).strokeColor(BORDER).stroke();
        y += ROW_H;
      });

      // Grand total row
      ensureSpace(28);
      goldRule(y, 1.5);
      y += 3;
      doc.rect(ML, y, CW, 26).fill(INK);
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(GOLD_LT)
         .text("GRAND TOTAL — ALL PAGES", ML + 12, y + 8, { width: CW * 0.6 });
      doc.font("Helvetica-Bold").fontSize(12).fillColor(GOLD)
         .text(`Tk. ${grandTotal.toLocaleString("en-IN")}`, ML + 4, y + 7, { width: CW - 8, align: "right" });
      y += 26;
      goldRule(y, 1.5);

      drawFooter();
      doc.end();
    });

    const fname = `alishan-moments-sales-${new Date().toISOString().slice(0,10)}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.send(pdfBuffer);

  } catch (err) {
    console.error("Sales PDF export error:", err);
    if (!res.headersSent) res.status(500).json({ success: false, message: "Export failed." });
  }
});

function drawPageFooter(doc, PAGE_W, PAGE_H, ML, CW, MUTED, GOLD, date) {
  const fy = PAGE_H - 36;
  doc.moveTo(ML, fy).lineTo(ML + CW, fy).lineWidth(0.5).strokeColor(GOLD).stroke();
  doc.font("Helvetica").fontSize(6.5).fillColor(MUTED)
     .text("Alishan Moments  ·  Confidential — Authorized Personnel Only", ML, fy + 6, { width: CW * 0.6 });
  doc.font("Helvetica").fontSize(6.5).fillColor(MUTED)
     .text(date, ML, fy + 6, { width: CW, align: "right" });
}

app.get(/^(?!\/api).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀  Alishan Moments server running → http://localhost:${PORT}`);
  console.log(`    Customer form : http://localhost:${PORT}/index.html`);
  console.log(`    Admin panel   : http://localhost:${PORT}/admin.html`);
});
