require("dotenv").config(); // ✅ MUST be first — loads env vars before anything uses them

const express    = require("express");
const mongoose   = require("mongoose");
const multer     = require("multer");
const cors       = require("cors");
const path       = require("path");
const fs         = require("fs");
const { Parser } = require("json2csv");
const archiver   = require("archiver");

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
    const { categoryId, categoryName, categoryPrice, fullName, phone, specialDate, message } = req.body;

    if (!categoryId || !fullName || !phone || !specialDate || !message) {
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
      fullName, phone, specialDate, message, photos,
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

    const photoItems = o.photos.map((p, i) => `
      <div class="photo-item">
        <div class="photo-num">Photo ${i + 1}</div>
        <div class="photo-name">${p.originalName || p.filename}</div>
        <div class="photo-hint">See photos/ folder in this ZIP</div>
      </div>`).join("");

    const detailsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Order — ${o.fullName}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=DM+Sans:wght@400;500;600&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'DM Sans',sans-serif;background:#f5f0e8;color:#1a1612;padding:2.5rem;max-width:720px;margin:0 auto}
  .header{background:#1a1612;color:#f5f0e8;border-radius:14px;padding:2rem 2.5rem;margin-bottom:2rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem}
  .header__logo{font-family:'Cormorant Garamond',serif;font-size:1.5rem;color:#e8c97a}
  .header__id{font-family:monospace;font-size:.72rem;color:rgba(245,240,232,.45);word-break:break-all;max-width:260px;text-align:right}
  .status-chip{display:inline-block;padding:.3rem .85rem;border-radius:50px;font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
  .status-pending{background:rgba(212,129,58,.15);color:#d4813a;border:1px solid rgba(212,129,58,.4)}
  .status-confirmed{background:rgba(106,156,122,.15);color:#6a9c7a;border:1px solid rgba(106,156,122,.4)}
  .status-done{background:rgba(26,22,18,.08);color:#888;border:1px solid rgba(26,22,18,.2)}
  .card{background:#fff;border-radius:14px;padding:1.75rem 2rem;margin-bottom:1.25rem;box-shadow:0 2px 12px rgba(26,22,18,.07)}
  .card__title{font-family:'Cormorant Garamond',serif;font-size:1.1rem;font-weight:600;color:#1a1612;margin-bottom:1.2rem;padding-bottom:.6rem;border-bottom:1px solid rgba(26,22,18,.08)}
  .field{display:grid;grid-template-columns:140px 1fr;gap:.5rem;padding:.55rem 0;border-bottom:1px solid rgba(26,22,18,.05)}
  .field:last-child{border-bottom:none}
  .field__label{font-size:.72rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:rgba(26,22,18,.45);padding-top:.1rem}
  .field__value{font-size:.9rem;color:#1a1612;line-height:1.55;word-break:break-word}
  .field__value.phone{font-family:monospace;color:#b8873a;font-size:.92rem;font-weight:600}
  .field__value.price{color:#b8873a;font-weight:700}
  .message-box{background:#f5f0e8;border-radius:10px;padding:1.1rem 1.25rem;font-size:.9rem;line-height:1.7;white-space:pre-wrap;word-break:break-word;border-left:3px solid #b8873a;margin-top:.3rem}
  .photo-item{display:flex;align-items:center;gap:.75rem;padding:.6rem 0;border-bottom:1px solid rgba(26,22,18,.05)}
  .photo-item:last-child{border-bottom:none}
  .photo-num{font-size:.7rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:rgba(26,22,18,.4);width:55px;flex-shrink:0}
  .photo-name{font-size:.85rem;color:#1a1612;flex:1;word-break:break-all}
  .photo-hint{font-size:.7rem;color:rgba(26,22,18,.4);flex-shrink:0}
  .footer{text-align:center;font-size:.75rem;color:rgba(26,22,18,.35);margin-top:2rem;padding-top:1rem;border-top:1px solid rgba(26,22,18,.1)}
  @media print{body{background:#fff;padding:1rem}.header{border-radius:0}}
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="header__logo">◈ Memory Frames</div>
    <div style="margin-top:.5rem">${submittedAt}</div>
  </div>
  <div style="text-align:right">
    <span class="status-chip status-${o.status}">${o.status.charAt(0).toUpperCase()+o.status.slice(1)}</span>
    <div class="header__id">Order ID: ${o._id}</div>
  </div>
</div>

<div class="card">
  <div class="card__title">Customer Information</div>
  <div class="field"><div class="field__label">Full Name</div><div class="field__value">${o.fullName}</div></div>
  <div class="field"><div class="field__label">Phone</div><div class="field__value phone">${o.phone}</div></div>
</div>

<div class="card">
  <div class="card__title">Frame Details</div>
  <div class="field"><div class="field__label">Frame Type</div><div class="field__value">${o.categoryName}</div></div>
  <div class="field"><div class="field__label">Price</div><div class="field__value price">${o.categoryPrice}</div></div>
  <div class="field"><div class="field__label">Special Date</div><div class="field__value">${specialDate}</div></div>
</div>

<div class="card">
  <div class="card__title">Personal Message</div>
  <div class="message-box">${o.message}</div>
</div>

${o.photos.length ? `
<div class="card">
  <div class="card__title">Uploaded Photos (${o.photos.length})</div>
  ${photoItems}
</div>` : ""}

<div class="footer">
  Generated by Memory Frames Admin Panel &nbsp;·&nbsp; ${new Date().toLocaleDateString("en-GB", {day:"2-digit",month:"long",year:"numeric"})}
</div>

</body>
</html>`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => { throw err; });
    archive.pipe(res);

    archive.append(detailsHtml, { name: "order-details.html" });

    o.photos.forEach((p) => {
      const filePath = path.join(__dirname, "uploads", p.filename);
      if (fs.existsSync(filePath)) {
        const ext      = path.extname(p.filename);
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
