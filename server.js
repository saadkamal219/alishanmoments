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
  .then(() => console.log("✅ MongoDB Connected"))
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
    specialDate:   { type: String, required: true },
    fbPage:        { type: String, required: true, trim: true },
    message:       { type: String, required: true, trim: true },
    photos:        [photoSchema],
    status: {
      type:    String,
      enum:    ["pending", "confirmed", "done"],
      default: "pending",
    },
  },
  {
    timestamps: true,   
    collection: "orders", 
  }
);

const Order = mongoose.model("Order", orderSchema);

app.post("/api/orders", upload.array("photos", 20), async (req, res) => {
  try {
    const { categoryId, categoryName, categoryPrice, fullName, phone, fbPage, specialDate, message } = req.body;

    if (!categoryId || !fullName || !phone || !fbPage || !specialDate || !message) {
      return res.status(400).json({ success: false, message: "All fields are required." });
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
      url:          `${BASE_URL}/uploads/${f.filename}`, // ✅ absolute URL — works on Render
    }));

    const order = new Order({
      categoryId, categoryName, categoryPrice,
      fullName, phone, fbPage, specialDate, message, photos,
    });

    await order.save();

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

app.patch("/api/orders/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["pending", "confirmed", "done"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status." });
    }
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
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

    const rows = orders.map((o) => ({
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
    }));

    const parser = new Parser({ fields: Object.keys(rows[0] || {}) });
    const csv    = parser.parse(rows);
    const date   = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="memory-frames-orders-${date}.csv"`);
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

    // ✅ Generate PDF using pdfkit — pure Node.js, no system dependencies
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
      const W      = doc.page.width - 100; // usable width (margins 50 each side)

      // ── HEADER BAR ──
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

      // helper: draw a section card
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

      // ── CUSTOMER INFO ──
      sectionTitle("Customer Information");
      field("Full Name",     o.fullName);
      field("Phone",         o.phone);
      field("Facebook Page", o.fbPage || "—");
      y += 10;

      // ── FRAME DETAILS ──
      sectionTitle("Frame Details");
      field("Frame Type",   o.categoryName);
      field("Price",        o.categoryPrice);
      field("Special Date", specialDate);
      y += 10;

      // ── MESSAGE ──
      sectionTitle("Personal Message");
      if (y > 700) { doc.addPage(); y = 50; }
      doc.rect(50, y, W, 1).fill(CREAM);
      doc.fontSize(9).fillColor(INK).font("Helvetica")
         .text(o.message || "—", 60, y + 8, { width: W - 20, lineGap: 4 });
      y += doc.heightOfString(o.message || "—", { width: W - 20 }) + 24;

      // ── PHOTOS LIST ──
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

      // ── FOOTER ──
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

// ✅ Only serve index.html for non-API routes (prevents wildcard swallowing API calls)
app.get(/^(?!\/api).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀  Memory Frames server running → http://localhost:${PORT}`);
  console.log(`    Customer form : http://localhost:${PORT}/index.html`);
  console.log(`    Admin panel   : http://localhost:${PORT}/admin.html`);
});
