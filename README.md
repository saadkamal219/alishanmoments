# Memory Frames — Full Stack Setup Guide

## Project Structure

```
memory-frames/
├── server.js            ← Backend (Express + Mongoose)
├── package.json
├── uploads/             ← Auto-created — stores customer photos
└── public/              ← Put your frontend files here
    ├── order.html       ← Customer order page  (rename order-direct.html)
    └── admin.html       ← Admin panel
```

---

## 1. Install Dependencies

```bash
npm install
```

---

## 2. Folder Setup

Create a `public/` folder and move the frontend files into it:

```bash
mkdir public
mv order-direct.html public/order.html
mv admin.html         public/admin.html
```

---

## 3. Start the Server

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

Server starts at: **http://localhost:3000**

---

## 4. Access the Pages

| Page           | URL                                    |
|----------------|----------------------------------------|
| Customer Form  | http://localhost:3000/order.html       |
| Admin Panel    | http://localhost:3000/admin.html       |

---

## 5. Admin Login

| Field    | Value                  |
|----------|------------------------|
| Username | `admin`                |
| Password | `memoryframes2025`     |

> To change the password: edit the `ADMIN_CREDS` object in `admin.html`.

---

## 6. API Endpoints (Reference)

| Method | Route                        | Description                  |
|--------|------------------------------|------------------------------|
| POST   | /api/orders                  | Submit a new order           |
| GET    | /api/orders                  | List all orders (with filter)|
| GET    | /api/orders/stats            | Dashboard stat counts        |
| PATCH  | /api/orders/:id/status       | Update order status          |
| DELETE | /api/orders/:id              | Delete a single order        |
| DELETE | /api/orders/done/all         | Delete all "done" orders     |
| GET    | /api/orders/export/csv       | Download all orders as CSV   |
| GET    | /api/orders/export/csv/:id   | Download single order as CSV |

---

## 7. Database

- **Cluster:** MongoDB Atlas
- **Database:** `alishan_moments`
- **Collection:** `orders`

Each order document contains:
```json
{
  "_id": "ObjectId",
  "categoryId": "1",
  "categoryName": "Anniversary Frame",
  "categoryPrice": "৳ 850",
  "fullName": "Customer Name",
  "phone": "01712345678",
  "specialDate": "2025-06-14",
  "message": "Happy Anniversary...",
  "photos": [
    { "filename": "...", "originalName": "...", "url": "/uploads/..." }
  ],
  "status": "pending | confirmed | done",
  "createdAt": "ISO date",
  "updatedAt": "ISO date"
}
```

---

## 8. Admin Workflow

1. Customer submits order → appears as **⏳ Pending** in admin
2. Admin calls customer to confirm
3. Admin clicks **✓ Confirmed** → status becomes **✓ Confirmed**
4. After order is fulfilled → click **✓ Mark Done**
5. Download CSV anytime with **⬇ CSV** (single) or **⬇ Download All** (bulk)
6. Click **🗑 Delete Done Orders** to clean up completed records
