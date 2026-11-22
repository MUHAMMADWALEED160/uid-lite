// =====================================================================
//  University Information Display System  -  server.js
//  The WHOLE backend is in this one file. Use Ctrl+F on the section names:
//
//   1. SETUP          packages, helper functions
//   2. MODELS         database structure (User, Category, Notice, LostFoundItem, Claim)
//   3. HELPERS        search / chart / display helper functions
//   4. MIDDLEWARE     login + admin guards, file upload
//   5. ROUTES         auth, notices, items, display, admin (what each URL does)
//   6. APP            server config, sessions, mounting routes, start
//
//  Pages (HTML) are in views/page.ejs, design (CSS) is in public/style.css.
// =====================================================================

require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const path = require("path");


// ======================================================================
// 1. SETUP
// ======================================================================
// ---------- tiny module system: lets the sections below stay separate in one file ----------
const modules = {};
const define = (name, factory) => {
  const m = { exports: {} };
  factory(m, m.exports);
  modules[name] = m.exports;
};
const use = (name) => modules[name];

// ======================================================================
// 2. MODELS
// Each model describes one MongoDB collection (what fields it has).
// ======================================================================

// ---------- models/User.js ----------
define("models/User", (module, exports) => {
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6 },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    department: { type: String, default: "Other", trim: true }
  },
  { timestamps: true }
);

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

// Compare entered password with hashed one
userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

module.exports = mongoose.model("User", userSchema);
});

// ---------- models/Category.js ----------
define("models/Category", (module, exports) => {
const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    type: { type: String, enum: ["notice", "item"], default: "notice" }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Category", categorySchema);
});

// ---------- models/Notice.js ----------
define("models/Notice", (module, exports) => {
const mongoose = require("mongoose");

const noticeSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
    department: { type: String, default: "All" },
    attachment: {
      filename: String,       // saved name inside uploads/
      originalName: String,   // name user uploaded
      mimetype: String
    },
    isPinned: { type: Boolean, default: false },
    publishDate: { type: Date, default: Date.now },
    expiryDate: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);

// Active = the publish date has arrived and the expiry date has not passed
noticeSchema.statics.activeFilter = function () {
  const now = new Date();
  return {
    publishDate: { $lte: now },
    $or: [{ expiryDate: null }, { expiryDate: { $gt: now } }]
  };
};

module.exports = mongoose.model("Notice", noticeSchema);
});

// ---------- models/LostFoundItem.js ----------
define("models/LostFoundItem", (module, exports) => {
const mongoose = require("mongoose");

const itemSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["lost", "found"], required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
    location: { type: String, required: true, trim: true },
    date: { type: Date, required: true },
    image: {
      filename: String,
      originalName: String
    },
    contactInfo: { type: String, required: true, trim: true },
    // Lost -> Found -> Claimed -> Returned
    status: { type: String, enum: ["lost", "found", "claimed", "returned"] },
    // Items become public only after admin approval
    approval: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: true }
);

// The initial status equals the type (lost or found)
itemSchema.pre("validate", function (next) {
  if (!this.status) this.status = this.type;
  next();
});

module.exports = mongoose.model("LostFoundItem", itemSchema);
});

// ---------- models/Claim.js ----------
define("models/Claim", (module, exports) => {
const mongoose = require("mongoose");

const claimSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: "LostFoundItem", required: true },
    claimedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    message: { type: String, required: true, trim: true },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" }
  },
  { timestamps: true }
);

// One user can submit only one claim per item
claimSchema.index({ item: 1, claimedBy: 1 }, { unique: true });

module.exports = mongoose.model("Claim", claimSchema);
});

// ======================================================================
// 3. HELPERS
// ======================================================================

// ---------- utils/helpers.js ----------
define("utils/helpers", (module, exports) => {
// Small helper functions used by several routes.
// Part 1: search/filter helpers, Part 2: dashboard chart helpers, Part 3: Display Mode data mappers.

// ===== Part 1: search / filter =====
// Escape user text so it is safe to use inside a regex
exports.escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "2026-11-18" -> start / end of that day. Returns null for a bad format
function parseDay(str, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str || "")) return null;
  const d = new Date(str + time);
  return isNaN(d) ? null : d;
}
exports.dayStart = (str) => parseDay(str, "T00:00:00");
exports.dayEnd = (str) => parseDay(str, "T23:59:59.999");

// { q: "exam", page: "" } -> "q=exam" (empty values are dropped)
exports.buildQS = (obj) => {
  const p = new URLSearchParams();
  Object.keys(obj).forEach((k) => {
    if (obj[k]) p.set(k, obj[k]);
  });
  return p.toString();
};

// ===== Part 2: dashboard charts =====
// Last 6 months (including the current one), oldest first
exports.buildMonths = (now = new Date(), count = 6) => {
  const months = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({
      y: d.getUTCFullYear(),
      m: d.getUTCMonth() + 1,
      label: d.toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })
    });
  }
  return months;
};

// Build the series for one type from aggregation rows [{_id:{y,m,t}, n}]
exports.seriesFor = (months, rows, type) =>
  months.map((mo) =>
    rows
      .filter((r) => r._id.y === mo.y && r._id.m === mo.m && r._id.t === type)
      .reduce((sum, r) => sum + r.n, 0)
  );

// ===== Part 3: Display Mode =====
const truncate = (s, n) => {
  s = s || "";
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
};

exports.truncate = truncate;

exports.noticeSlide = (n) => ({
  id: String(n._id),
  title: n.title,
  description: truncate(n.description, 320),
  category: n.category ? n.category.name : "",
  department: n.department || "All",
  publishDate: n.publishDate,
  expiryDate: n.expiryDate || null,
  // Only image attachments are shown on slides (not PDFs)
  image:
    n.attachment && n.attachment.filename && /^image\//.test(n.attachment.mimetype || "")
      ? "/uploads/" + n.attachment.filename
      : ""
});

exports.itemSlide = (i) => ({
  id: String(i._id),
  title: i.title,
  description: truncate(i.description, 220),
  category: i.category ? i.category.name : "",
  location: i.location,
  date: i.date,
  image: i.image && i.image.filename ? "/uploads/" + i.image.filename : ""
});
});

// ======================================================================
// 4. MIDDLEWARE
// auth.js = who may open a page, upload.js = file uploads (PDF/images).
// ======================================================================

// ---------- middleware/auth.js ----------
define("middleware/auth", (module, exports) => {
// Only logged-in users
exports.isLoggedIn = (req, res, next) => {
  if (req.session.user) return next();
  req.session.flash = { type: "warning", text: "Please log in first." };
  res.redirect("/login");
};

// Only admins
exports.isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === "admin") return next();
  if (!req.session.user) {
    req.session.flash = { type: "warning", text: "Please log in first." };
    return res.redirect("/login");
  }
  res.status(403).render("error", { title: "Access Denied", code: 403, message: "Access denied. This page is for administrators only." });
};

// Only guests (not logged in)
exports.isGuest = (req, res, next) => {
  if (!req.session.user) return next();
  res.redirect("/");
};
});

// ---------- middleware/upload.js ----------
define("middleware/upload", (module, exports) => {
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const UPLOAD_DIR = path.join(__dirname, "uploads");
const ATTACHMENT_EXT = [".pdf", ".jpg", ".jpeg", ".png", ".webp"];
const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp"];

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now() + "-" + crypto.randomBytes(6).toString("hex") + ext);
  }
});

// field = form field name, allowed = allowed extensions
function makeUploader(field, allowed, typeError) {
  const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowed.includes(ext)) return cb(null, true);
      cb(new Error(typeError));
    }
  });

  // Upload errors do not crash the request; they are stored in req.uploadError
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (err) {
        req.uploadError =
          err.code === "LIMIT_FILE_SIZE" ? "File must be smaller than 5 MB." : err.message;
      }
      next();
    });
  };
}

exports.uploadAttachment = makeUploader(
  "attachment",
  ATTACHMENT_EXT,
  "Only PDF, JPG, PNG or WEBP files are allowed."
);

exports.uploadImage = makeUploader(
  "image",
  IMAGE_EXT,
  "Only JPG, PNG or WEBP images are allowed."
);

// Delete a file from uploads/
exports.removeUpload = (filename) => {
  if (!filename) return;
  fs.unlink(path.join(UPLOAD_DIR, filename), () => {});
};
});

// ======================================================================
// 5. ROUTES
// A route decides what happens for a URL, then picks a page from views/page.ejs.
// ======================================================================

// ---------- routes/auth.js ----------
// Signup, login, logout
define("routes/auth", (module, exports) => {
const express = require("express");
const User = use("models/User");
const { isGuest } = use("middleware/auth");

const router = express.Router();

// ---------- Signup ----------
router.get("/signup", isGuest, (req, res) => {
  res.render("auth/signup", { title: "Sign up", old: {} });
});

router.post("/signup", isGuest, async (req, res) => {
  const { name, email, password, confirmPassword, department } = req.body;
  try {
    if (!name || !email || !password) {
      throw new Error("All fields are required.");
    }
    if (password.length < 6) {
      throw new Error("Password must be at least 6 characters long.");
    }
    if (password !== confirmPassword) {
      throw new Error("The two passwords do not match.");
    }
    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) throw new Error("An account with this email already exists.");

    // role is always "user"; admins are created only with the seed script
    await User.create({ name, email, password, department, role: "user" });

    req.session.flash = { type: "success", text: "Account created! You can log in now." };
    res.redirect("/login");
  } catch (err) {
    res.render("auth/signup", {
      title: "Sign up",
      old: { name, email, department },
      error: err.message
    });
  }
});

// ---------- Login ----------
router.get("/login", isGuest, (req, res) => {
  res.render("auth/login", { title: "Login", old: {} });
});

router.post("/login", isGuest, async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email: (email || "").toLowerCase().trim() });
    const ok = user && (await user.comparePassword(password || ""));
    if (!ok) throw new Error("Incorrect email or password.");

    // new session id on login (protects against session fixation)
    req.session.regenerate((err) => {
      if (err) throw err;
      req.session.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department
      };
      req.session.flash = { type: "success", text: `Welcome, ${user.name}!` };
      req.session.save(() => {
        res.redirect(user.role === "admin" ? "/admin" : "/");
      });
    });
  } catch (err) {
    res.render("auth/login", { title: "Login", old: { email }, error: err.message });
  }
});

// ---------- Logout ----------
router.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/");
  });
});

module.exports = router;
});

// ---------- routes/notices.js ----------
// Public notices list and detail page (search, filters)
define("routes/notices", (module, exports) => {
const express = require("express");
const mongoose = require("mongoose");
const Notice = use("models/Notice");
const Category = use("models/Category");
const { escapeRegex, dayStart, dayEnd, buildQS } = use("utils/helpers");

const router = express.Router();
const PER_PAGE = 6;
const DEPARTMENTS = ["CS", "EE", "BBA", "Other"];
const SORTS = {
  urgent: { isPinned: -1, publishDate: -1 }, // pinned first, then newest
  newest: { publishDate: -1 },
  oldest: { publishDate: 1 }
};

// Public list: search + filter + sort + pagination
router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);

    // Filters from the query string (invalid values are ignored)
    const f = {
      q: (req.query.q || "").trim().slice(0, 100),
      category: mongoose.isValidObjectId(req.query.category) ? req.query.category : "",
      department: DEPARTMENTS.includes(req.query.department) ? req.query.department : "",
      from: dayStart(req.query.from) ? req.query.from : "",
      to: dayEnd(req.query.to) ? req.query.to : "",
      sort: SORTS[req.query.sort] ? req.query.sort : "urgent"
    };

    // Active notices only, plus the user's filters
    const conds = [Notice.activeFilter()];
    if (f.q) {
      const rx = new RegExp(escapeRegex(f.q), "i");
      conds.push({ $or: [{ title: rx }, { description: rx }] });
    }
    if (f.category) conds.push({ category: f.category });
    // If a department is chosen, show its notices plus the "All" ones
    if (f.department) conds.push({ department: { $in: [f.department, "All"] } });
    if (f.from) conds.push({ publishDate: { $gte: dayStart(f.from) } });
    if (f.to) conds.push({ publishDate: { $lte: dayEnd(f.to) } });
    const filter = { $and: conds };

    const [total, notices, categories] = await Promise.all([
      Notice.countDocuments(filter),
      Notice.find(filter)
        .populate("category")
        .sort(SORTS[f.sort])
        .skip((page - 1) * PER_PAGE)
        .limit(PER_PAGE),
      Category.find({ type: "notice" }).sort("name")
    ]);

    res.render("notices/list", {
      title: "Notices",
      notices,
      categories,
      departments: DEPARTMENTS,
      f,
      total,
      page,
      totalPages: Math.max(Math.ceil(total / PER_PAGE), 1),
      baseQS: buildQS(f.sort === "urgent" ? { ...f, sort: "" } : f),
      filtered: !!(f.q || f.category || f.department || f.from || f.to || f.sort !== "urgent")
    });
  } catch (err) {
    next(err);
  }
});

// Detail page
router.get("/:id", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).render("error", { title: "Not found", code: 404, message: "Page not found." });
    }
    const notice = await Notice.findById(req.params.id)
      .populate("category")
      .populate("createdBy", "name");
    if (!notice) return res.status(404).render("error", { title: "Not found", code: 404, message: "Page not found." });

    // Expired / scheduled notices are visible to admins only
    const now = new Date();
    const isActive =
      notice.publishDate <= now && (!notice.expiryDate || notice.expiryDate > now);
    const isAdmin = req.session.user && req.session.user.role === "admin";
    if (!isActive && !isAdmin) {
      return res.status(404).render("error", { title: "Not found", code: 404, message: "Page not found." });
    }

    res.render("notices/detail", { title: notice.title, notice, isActive });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
});

// ---------- routes/items.js ----------
// Lost & Found for users: list, report, claim
define("routes/items", (module, exports) => {
const express = require("express");
const mongoose = require("mongoose");
const Item = use("models/LostFoundItem");
const Claim = use("models/Claim");
const Category = use("models/Category");
const { isLoggedIn } = use("middleware/auth");
const { uploadImage, removeUpload } = use("middleware/upload");
const { escapeRegex, dayStart, dayEnd, buildQS } = use("utils/helpers");

const router = express.Router();
const PER_PAGE = 9;
const STATUSES = ["lost", "found", "claimed", "returned"];
const SORTS = {
  newest: { date: -1, createdAt: -1 },
  oldest: { date: 1, createdAt: 1 }
};

async function renderForm(res, { type, old = {}, error = null, status = 200 }) {
  const categories = await Category.find({ type: "item" }).sort("name");
  res.status(status).render("items/form", {
    title: type === "found" ? "Report Found Item" : "Report Lost Item",
    type,
    old,
    error,
    categories
  });
}

// ---------- Public list (approved only) + search/filter ----------
router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);

    const f = {
      q: (req.query.q || "").trim().slice(0, 100),
      type: ["lost", "found"].includes(req.query.type) ? req.query.type : "",
      category: mongoose.isValidObjectId(req.query.category) ? req.query.category : "",
      status: STATUSES.includes(req.query.status) ? req.query.status : "",
      from: dayStart(req.query.from) ? req.query.from : "",
      to: dayEnd(req.query.to) ? req.query.to : "",
      sort: SORTS[req.query.sort] ? req.query.sort : "newest"
    };

    const conds = [{ approval: "approved" }];
    if (f.q) {
      const rx = new RegExp(escapeRegex(f.q), "i");
      conds.push({ $or: [{ title: rx }, { description: rx }, { location: rx }] });
    }
    if (f.type) conds.push({ type: f.type });
    if (f.category) conds.push({ category: f.category });
    if (f.status) conds.push({ status: f.status });
    if (f.from) conds.push({ date: { $gte: dayStart(f.from) } });
    if (f.to) conds.push({ date: { $lte: dayEnd(f.to) } });
    const filter = { $and: conds };

    const [total, items, categories] = await Promise.all([
      Item.countDocuments(filter),
      Item.find(filter)
        .populate("category")
        .sort(SORTS[f.sort])
        .skip((page - 1) * PER_PAGE)
        .limit(PER_PAGE),
      Category.find({ type: "item" }).sort("name")
    ]);

    res.render("items/list", {
      title: "Lost & Found",
      items,
      categories,
      statuses: STATUSES,
      f,
      total,
      page,
      totalPages: Math.max(Math.ceil(total / PER_PAGE), 1),
      baseQS: buildQS(f.sort === "newest" ? { ...f, sort: "" } : f),
      filtered: !!(f.q || f.type || f.category || f.status || f.from || f.to || f.sort !== "newest")
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Report form ----------
router.get("/new", isLoggedIn, async (req, res, next) => {
  try {
    const type = req.query.type === "found" ? "found" : "lost";
    await renderForm(res, { type });
  } catch (err) {
    next(err);
  }
});

router.post("/", isLoggedIn, uploadImage, async (req, res, next) => {
  try {
    const b = req.body;
    const type = b.type === "found" ? "found" : "lost";
    const date = b.date ? new Date(b.date + "T00:00:00") : null;

    let error = req.uploadError || null;
    if (!error && !(b.title || "").trim()) error = "Title is required.";
    if (!error && !(b.description || "").trim()) error = "Description is required.";
    if (!error && !(b.location || "").trim()) error = "Location is required.";
    if (!error && !(b.contactInfo || "").trim()) error = "Contact info is required.";
    if (!error && (!date || isNaN(date))) error = "Please enter a valid date.";
    if (!error && date > new Date()) error = "The date cannot be in the future.";

    let category = null;
    if (!error) {
      category = mongoose.isValidObjectId(b.category)
        ? await Category.findOne({ _id: b.category, type: "item" })
        : null;
      if (!category) error = "Please select a category.";
    }

    if (error) {
      if (req.file) removeUpload(req.file.filename);
      return renderForm(res, { type, old: b, error, status: 400 });
    }

    const isAdmin = req.session.user.role === "admin";
    const data = {
      type,
      title: b.title.trim(),
      description: b.description.trim(),
      category: category._id,
      location: b.location.trim(),
      date,
      contactInfo: b.contactInfo.trim(),
      postedBy: req.session.user.id,
      approval: isAdmin ? "approved" : "pending"
    };
    if (req.file) {
      data.image = { filename: req.file.filename, originalName: req.file.originalname };
    }
    await Item.create(data);

    req.session.flash = {
      type: "success",
      text: isAdmin
        ? "Item posted."
        : "Report submitted. It will become public once an admin approves it."
    };
    res.redirect(isAdmin ? "/items" : "/items/mine");
  } catch (err) {
    next(err);
  }
});

// ---------- My reports + my claims ----------
router.get("/mine", isLoggedIn, async (req, res, next) => {
  try {
    const [items, claims] = await Promise.all([
      Item.find({ postedBy: req.session.user.id }).populate("category").sort({ createdAt: -1 }),
      Claim.find({ claimedBy: req.session.user.id })
        .populate("item", "title type status")
        .sort({ createdAt: -1 })
    ]);
    res.render("items/mine", { title: "My Reports", items, claims });
  } catch (err) {
    next(err);
  }
});

// ---------- Detail ----------
router.get("/:id", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).render("error", { title: "Not found", code: 404, message: "Page not found." });
    }
    const item = await Item.findById(req.params.id)
      .populate("category")
      .populate("postedBy", "name department");
    if (!item) return res.status(404).render("error", { title: "Not found", code: 404, message: "Page not found." });

    const user = req.session.user || null;
    const isAdmin = !!user && user.role === "admin";
    const isOwner = !!user && item.postedBy && String(item.postedBy._id) === user.id;

    // Pending/rejected items are visible only to the owner and admins
    if (item.approval !== "approved" && !isAdmin && !isOwner) {
      return res.status(404).render("error", { title: "Not found", code: 404, message: "Page not found." });
    }

    const myClaim = user ? await Claim.findOne({ item: item._id, claimedBy: user.id }) : null;
    const canClaim =
      !!user &&
      !isOwner &&
      item.approval === "approved" &&
      item.type === "found" &&
      item.status === "found" &&
      !myClaim;

    // A lost item's contact is shown to logged-in users (so a finder can reach out)
    // A found item's contact is shown only to the owner, admins and the approved claimant
    const canSeeContact =
      isAdmin ||
      isOwner ||
      (!!user && item.type === "lost") ||
      (!!myClaim && myClaim.status === "approved");

    res.render("items/detail", {
      title: item.title,
      item,
      isAdmin,
      isOwner,
      myClaim,
      canClaim,
      canSeeContact
    });
  } catch (err) {
    next(err);
  }
});

// ---------- "This is mine" claim ----------
router.post("/:id/claim", isLoggedIn, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.redirect("/items");
    const item = await Item.findById(req.params.id);
    const back = "/items/" + req.params.id;

    if (!item || item.approval !== "approved" || item.type !== "found" || item.status !== "found") {
      req.session.flash = { type: "danger", text: "This item cannot be claimed." };
      return res.redirect("/items");
    }
    if (String(item.postedBy) === req.session.user.id) {
      req.session.flash = { type: "danger", text: "You cannot claim your own post." };
      return res.redirect(back);
    }
    const message = (req.body.message || "").trim();
    if (message.length < 10) {
      req.session.flash = {
        type: "danger",
        text: "Please describe your proof of ownership (at least 10 characters): marks, colour, contents, etc."
      };
      return res.redirect(back);
    }

    await Claim.create({ item: item._id, claimedBy: req.session.user.id, message });
    req.session.flash = { type: "success", text: "Your claim request has been sent to the admin." };
    res.redirect(back);
  } catch (err) {
    if (err.code === 11000) {
      req.session.flash = { type: "warning", text: "You have already submitted a claim for this item." };
      return res.redirect("/items/" + req.params.id);
    }
    next(err);
  }
});

// ---------- Delete (owner or admin) ----------
router.post("/:id/delete", isLoggedIn, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.redirect("/items/mine");
    const item = await Item.findById(req.params.id);
    const isAdmin = req.session.user.role === "admin";
    if (item && (isAdmin || String(item.postedBy) === req.session.user.id)) {
      removeUpload(item.image && item.image.filename);
      await Claim.deleteMany({ item: item._id });
      await item.deleteOne();
      req.session.flash = { type: "success", text: "Item deleted." };
    }
    res.redirect(isAdmin ? "/admin/items" : "/items/mine");
  } catch (err) {
    next(err);
  }
});

module.exports = router;
});

// ---------- routes/display.js ----------
// Campus TV page and its JSON data
define("routes/display", (module, exports) => {
const express = require("express");
const Notice = use("models/Notice");
const Item = use("models/LostFoundItem");
const { noticeSlide, itemSlide } = use("utils/helpers");

const router = express.Router();

// Campus TV page (public, no login required)
// /display?interval=10 -> 10 seconds per slide (between 4 and 60)
router.get("/", (req, res) => {
  const interval = Math.min(Math.max(parseInt(req.query.interval) || 8, 4), 60);
  res.render("display", { interval });
});

// The page loads this JSON with fetch() and refreshes it every minute
router.get("/data", async (req, res, next) => {
  try {
    const active = Notice.activeFilter();
    const [urgent, latest, tickerNotices, found] = await Promise.all([
      Notice.find({ $and: [active, { isPinned: true }] })
        .populate("category", "name")
        .sort({ publishDate: -1 })
        .limit(5),
      Notice.find({ $and: [active, { isPinned: false }] })
        .populate("category", "name")
        .sort({ publishDate: -1 })
        .limit(6),
      Notice.find(active).select("title isPinned").sort({ isPinned: -1, publishDate: -1 }).limit(12),
      Item.find({ approval: "approved", type: "found", status: "found" })
        .populate("category", "name")
        .sort({ createdAt: -1 })
        .limit(5)
    ]);

    const ticker = tickerNotices
      .map((n) => ({ title: n.title, urgent: n.isPinned }))
      .concat(
        found.map((i) => ({
          title: "Found: " + i.title + (i.location ? " (" + i.location + ")" : ""),
          urgent: false
        }))
      );

    res.set("Cache-Control", "no-store");
    res.json({
      urgent: urgent.map(noticeSlide),
      latest: latest.map(noticeSlide),
      found: found.map(itemSlide),
      ticker
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
});

// ---------- routes/admin.js ----------
// ALL admin pages: dashboard, notices, categories, lost & found approvals, claims, users
define("routes/admin", (module, exports) => {
const express = require("express");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const Notice = use("models/Notice");
const Category = use("models/Category");
const Item = use("models/LostFoundItem");
const Claim = use("models/Claim");
const User = use("models/User");
const { isAdmin } = use("middleware/auth");
const { uploadAttachment, removeUpload } = use("middleware/upload");
const { buildMonths, seriesFor, escapeRegex } = use("utils/helpers");

const router = express.Router();
const DEPARTMENTS = ["All", "CS", "EE", "BBA", "Other"];

// All /admin routes are for admins only
router.use(isAdmin);

// ---------- helpers ----------
function removeFile(filename) {
  if (!filename) return;
  fs.unlink(path.join(__dirname, "uploads", filename), () => {});
}

async function renderNoticeForm(res, { notice = null, old = {}, error = null, status = 200 }) {
  const categories = await Category.find({ type: "notice" }).sort("name");
  res.status(status).render("admin/notice-form", {
    title: notice ? "Edit Notice" : "New Notice",
    notice,
    old,
    error,
    categories,
    departments: DEPARTMENTS
  });
}

function parseNoticeBody(b) {
  const publishDate = b.publishDate ? new Date(b.publishDate + "T00:00:00") : new Date();
  const expiryDate = b.expiryDate ? new Date(b.expiryDate + "T23:59:59") : null;
  return {
    title: (b.title || "").trim(),
    description: (b.description || "").trim(),
    category: b.category,
    department: b.department || "All",
    isPinned: b.isPinned === "on",
    publishDate,
    expiryDate
  };
}

function validateNotice(data) {
  if (!data.title) return "Title is required.";
  if (!data.description) return "Description is required.";
  if (!mongoose.isValidObjectId(data.category)) return "Please select a category.";
  if (data.expiryDate && data.expiryDate < data.publishDate) {
    return "The expiry date cannot be before the publish date.";
  }
  return null;
}

// ---------- dashboard ----------
router.get("/", async (req, res, next) => {
  try {
    const [
      totalNotices, activeNotices, totalUsers,
      lostItems, foundItems, claimedItems, pendingItems, pendingClaims
    ] = await Promise.all([
      Notice.countDocuments(),
      Notice.countDocuments(Notice.activeFilter()),
      User.countDocuments(),
      Item.countDocuments({ approval: "approved", status: "lost" }),
      Item.countDocuments({ approval: "approved", status: "found" }),
      Item.countDocuments({ approval: "approved", status: { $in: ["claimed", "returned"] } }),
      Item.countDocuments({ approval: "pending" }),
      Claim.countDocuments({ status: "pending" })
    ]);
    res.render("admin/dashboard", {
      title: "Admin Dashboard",
      stats: {
        totalNotices, activeNotices, totalUsers,
        lostItems, foundItems, claimedItems, pendingItems, pendingClaims
      }
    });
  } catch (err) {
    next(err);
  }
});

// ---------- categories ----------
router.get("/categories", async (req, res, next) => {
  try {
    const categories = await Category.find().sort("name");
    const counts = await Notice.aggregate([{ $group: { _id: "$category", n: { $sum: 1 } } }]);
    const used = {};
    counts.forEach((c) => (used[c._id] = c.n));
    res.render("admin/categories", { title: "Categories", categories, used });
  } catch (err) {
    next(err);
  }
});

router.post("/categories", async (req, res, next) => {
  try {
    const name = (req.body.name || "").trim();
    const type = req.body.type === "item" ? "item" : "notice";
    if (!name) {
      req.session.flash = { type: "danger", text: "Please enter a category name." };
    } else if (await Category.findOne({ name: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") })) {
      req.session.flash = { type: "danger", text: "This category already exists." };
    } else {
      await Category.create({ name, type });
      req.session.flash = { type: "success", text: "Category added." };
    }
    res.redirect("/admin/categories");
  } catch (err) {
    next(err);
  }
});

router.post("/categories/:id/edit", async (req, res, next) => {
  try {
    const name = (req.body.name || "").trim();
    if (!name || !mongoose.isValidObjectId(req.params.id)) {
      req.session.flash = { type: "danger", text: "Please enter a valid name." };
    } else {
      await Category.findByIdAndUpdate(req.params.id, { name });
      req.session.flash = { type: "success", text: "Category updated." };
    }
    res.redirect("/admin/categories");
  } catch (err) {
    if (err.code === 11000) {
      req.session.flash = { type: "danger", text: "This name already exists." };
      return res.redirect("/admin/categories");
    }
    next(err);
  }
});

router.post("/categories/:id/delete", async (req, res, next) => {
  try {
    if (mongoose.isValidObjectId(req.params.id)) {
      const inUse = await Notice.countDocuments({ category: req.params.id });
      if (inUse > 0) {
        req.session.flash = {
          type: "danger",
          text: `Cannot delete: ${inUse} notice(s) use this category.`
        };
      } else {
        await Category.findByIdAndDelete(req.params.id);
        req.session.flash = { type: "success", text: "Category deleted." };
      }
    }
    res.redirect("/admin/categories");
  } catch (err) {
    next(err);
  }
});

// ---------- notices ----------
router.get("/notices", async (req, res, next) => {
  try {
    const notices = await Notice.find().populate("category").sort({ createdAt: -1 });
    res.render("admin/notices", { title: "Manage Notices", notices, now: new Date() });
  } catch (err) {
    next(err);
  }
});

router.get("/notices/new", async (req, res, next) => {
  try {
    await renderNoticeForm(res, {});
  } catch (err) {
    next(err);
  }
});

router.post("/notices", uploadAttachment, async (req, res, next) => {
  try {
    const data = parseNoticeBody(req.body);
    const error = req.uploadError || validateNotice(data);
    if (error) {
      if (req.file) removeFile(req.file.filename);
      return renderNoticeForm(res, { old: req.body, error, status: 400 });
    }
    if (req.file) {
      data.attachment = {
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimetype: req.file.mimetype
      };
    }
    data.createdBy = req.session.user.id;
    await Notice.create(data);
    req.session.flash = { type: "success", text: "Notice published." };
    res.redirect("/admin/notices");
  } catch (err) {
    next(err);
  }
});

router.get("/notices/:id/edit", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.redirect("/admin/notices");
    const notice = await Notice.findById(req.params.id);
    if (!notice) return res.redirect("/admin/notices");
    await renderNoticeForm(res, { notice });
  } catch (err) {
    next(err);
  }
});

router.post("/notices/:id", uploadAttachment, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.redirect("/admin/notices");
    const notice = await Notice.findById(req.params.id);
    if (!notice) return res.redirect("/admin/notices");

    const data = parseNoticeBody(req.body);
    const error = req.uploadError || validateNotice(data);
    if (error) {
      if (req.file) removeFile(req.file.filename);
      return renderNoticeForm(res, { notice, old: req.body, error, status: 400 });
    }

    // Replace the old file if a new one was uploaded; also remove it if "remove" is ticked
    if (req.file) {
      removeFile(notice.attachment && notice.attachment.filename);
      data.attachment = {
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimetype: req.file.mimetype
      };
    } else if (req.body.removeAttachment === "on") {
      removeFile(notice.attachment && notice.attachment.filename);
      data.attachment = undefined;
    }

    notice.set(data);
    await notice.save();
    req.session.flash = { type: "success", text: "Notice updated." };
    res.redirect("/admin/notices");
  } catch (err) {
    next(err);
  }
});

router.post("/notices/:id/delete", async (req, res, next) => {
  try {
    if (mongoose.isValidObjectId(req.params.id)) {
      const notice = await Notice.findByIdAndDelete(req.params.id);
      if (notice) removeFile(notice.attachment && notice.attachment.filename);
      req.session.flash = { type: "success", text: "Notice deleted." };
    }
    res.redirect("/admin/notices");
  } catch (err) {
    next(err);
  }
});

// ======================= Lost & Found items =======================
const APPROVALS = ["pending", "approved", "rejected"];
const STATUSES = ["lost", "found", "claimed", "returned"];

function goBack(req, res, fallback) {
  res.redirect(req.get("Referer") || fallback);
}

// ---------- Items ----------
router.get("/items", async (req, res, next) => {
  try {
    const q = req.query.approval;
    const approval = q === "all" ? "all" : APPROVALS.includes(q) ? q : "pending";
    const filter = approval === "all" ? {} : { approval };

    const [items, grouped] = await Promise.all([
      Item.find(filter)
        .populate("category")
        .populate("postedBy", "name email")
        .sort({ createdAt: -1 }),
      Item.aggregate([{ $group: { _id: "$approval", n: { $sum: 1 } } }])
    ]);
    const counts = { pending: 0, approved: 0, rejected: 0 };
    grouped.forEach((g) => (counts[g._id] = g.n));

    res.render("admin/items", {
      title: "Manage Lost & Found",
      items,
      approval,
      counts,
      statuses: STATUSES
    });
  } catch (err) {
    next(err);
  }
});

router.post("/items/:id/approve", async (req, res, next) => {
  try {
    if (mongoose.isValidObjectId(req.params.id)) {
      await Item.findByIdAndUpdate(req.params.id, { approval: "approved" });
      req.session.flash = { type: "success", text: "Item approved. It is now public." };
    }
    goBack(req, res, "/admin/items");
  } catch (err) {
    next(err);
  }
});

router.post("/items/:id/reject", async (req, res, next) => {
  try {
    if (mongoose.isValidObjectId(req.params.id)) {
      await Item.findByIdAndUpdate(req.params.id, { approval: "rejected" });
      req.session.flash = { type: "warning", text: "Item rejected." };
    }
    goBack(req, res, "/admin/items");
  } catch (err) {
    next(err);
  }
});

router.post("/items/:id/status", async (req, res, next) => {
  try {
    if (mongoose.isValidObjectId(req.params.id) && STATUSES.includes(req.body.status)) {
      await Item.findByIdAndUpdate(req.params.id, { status: req.body.status });
      req.session.flash = { type: "success", text: "Status updated." };
    }
    goBack(req, res, "/admin/items");
  } catch (err) {
    next(err);
  }
});

router.post("/items/:id/delete", async (req, res, next) => {
  try {
    if (mongoose.isValidObjectId(req.params.id)) {
      const item = await Item.findByIdAndDelete(req.params.id);
      if (item) {
        removeUpload(item.image && item.image.filename);
        await Claim.deleteMany({ item: item._id });
      }
      req.session.flash = { type: "success", text: "Item deleted." };
    }
    goBack(req, res, "/admin/items");
  } catch (err) {
    next(err);
  }
});

// ---------- Claims ----------
router.get("/claims", async (req, res, next) => {
  try {
    const q = req.query.status;
    const status = q === "all" ? "all" : APPROVALS.includes(q) ? q : "pending";
    const filter = status === "all" ? {} : { status };

    const claims = await Claim.find(filter)
      .populate("item", "title type status")
      .populate("claimedBy", "name email department")
      .sort({ createdAt: -1 });

    res.render("admin/claims", { title: "Claim Requests", claims, status });
  } catch (err) {
    next(err);
  }
});

router.post("/claims/:id/approve", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.redirect("/admin/claims");
    const claim = await Claim.findById(req.params.id);
    if (claim && claim.status === "pending") {
      claim.status = "approved";
      await claim.save();
      // The item is now claimed; reject the other pending claims
      await Item.findByIdAndUpdate(claim.item, { status: "claimed" });
      await Claim.updateMany(
        { item: claim.item, _id: { $ne: claim._id }, status: "pending" },
        { status: "rejected" }
      );
      req.session.flash = { type: "success", text: "Claim approved. The item is now marked as Claimed." };
    }
    goBack(req, res, "/admin/claims");
  } catch (err) {
    next(err);
  }
});

router.post("/claims/:id/reject", async (req, res, next) => {
  try {
    if (mongoose.isValidObjectId(req.params.id)) {
      await Claim.findOneAndUpdate({ _id: req.params.id, status: "pending" }, { status: "rejected" });
      req.session.flash = { type: "warning", text: "Claim rejected." };
    }
    goBack(req, res, "/admin/claims");
  } catch (err) {
    next(err);
  }
});

// ======================= Dashboard chart data (JSON) =======================
// JSON data that the dashboard charts load with fetch()
router.get("/api/stats", async (req, res, next) => {
  try {
    const months = buildMonths(new Date(), 6);
    const start = new Date(Date.UTC(months[0].y, months[0].m - 1, 1));

    const [byCategory, byMonth] = await Promise.all([
      Notice.aggregate([
        { $group: { _id: "$category", n: { $sum: 1 } } },
        { $lookup: { from: Category.collection.name, localField: "_id", foreignField: "_id", as: "cat" } },
        {
          $project: {
            _id: 0,
            name: { $ifNull: [{ $arrayElemAt: ["$cat.name", 0] }, "Uncategorized"] },
            count: "$n"
          }
        },
        { $sort: { count: -1 } }
      ]),
      Item.aggregate([
        { $match: { approval: "approved", createdAt: { $gte: start } } },
        {
          $group: {
            _id: { y: { $year: "$createdAt" }, m: { $month: "$createdAt" }, t: "$type" },
            n: { $sum: 1 }
          }
        }
      ])
    ]);

    res.json({
      noticesPerCategory: byCategory,
      itemsPerMonth: {
        labels: months.map((m) => m.label),
        lost: seriesFor(months, byMonth, "lost"),
        found: seriesFor(months, byMonth, "found")
      }
    });
  } catch (err) {
    next(err);
  }
});

// ======================= Users =======================
// ---------- List ----------
router.get("/users", async (req, res, next) => {
  try {
    const q = (req.query.q || "").trim().slice(0, 100);
    const filter = {};
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ name: rx }, { email: rx }];
    }
    const users = await User.find(filter).select("-password").sort({ createdAt: -1 }).limit(200);
    res.render("admin/users", { title: "Manage Users", users, q });
  } catch (err) {
    next(err);
  }
});

// ---------- Role change ----------
router.post("/users/:id/role", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return res.redirect("/admin/users");
    if (id === req.session.user.id) {
      req.session.flash = { type: "danger", text: "You cannot change your own role." };
      return res.redirect("/admin/users");
    }
    const role = req.body.role === "admin" ? "admin" : "user";
    await User.findByIdAndUpdate(id, { role });
    req.session.flash = { type: "success", text: "Role updated (the user must log in again for it to take effect)." };
    res.redirect("/admin/users");
  } catch (err) {
    next(err);
  }
});

// ---------- Delete (user + their reports + claims) ----------
router.post("/users/:id/delete", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return res.redirect("/admin/users");
    if (id === req.session.user.id) {
      req.session.flash = { type: "danger", text: "You cannot delete your own account here." };
      return res.redirect("/admin/users");
    }

    const items = await Item.find({ postedBy: id });
    for (const it of items) {
      removeUpload(it.image && it.image.filename);
      await Claim.deleteMany({ item: it._id });
    }
    await Item.deleteMany({ postedBy: id });
    await Claim.deleteMany({ claimedBy: id });
    await User.findByIdAndDelete(id);

    req.session.flash = { type: "success", text: "User and their data deleted." };
    res.redirect("/admin/users");
  } catch (err) {
    next(err);
  }
});

module.exports = router;
});

// ======================================================================
// 6. APP
// Server settings, sessions, and connecting everything.
// ======================================================================
const Notice = use("models/Notice");
const Item = use("models/LostFoundItem");

const app = express();

// View engine (EJS)
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Sessions (stored in MongoDB)
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 day
  })
);

// All pages live in ONE template (views/page.ejs). res.render("notices/list", data)
// is turned into: render page.ejs, and show only the "notices/list" section.
app.use((req, res, next) => {
  const render = res.render.bind(res);
  res.render = (name, data) => render("page", { ...data, pageView: name });
  next();
});

// Available in every EJS view: logged-in user, flash message, date helpers
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;

  // 18 Nov 2026
  res.locals.fmtDate = (d) =>
    d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-";
  // 2026-11-18 (for date inputs)
  res.locals.inputDate = (d) => {
    const x = new Date(d);
    const p = (n) => String(n).padStart(2, "0");
    return x.getFullYear() + "-" + p(x.getMonth() + 1) + "-" + p(x.getDate());
  };
  // Bootstrap colour for a Lost/Found status
  res.locals.statusClass = (s) =>
    ({ lost: "danger", found: "success", claimed: "warning text-dark", returned: "secondary" }[s] || "secondary");
  next();
});

// Routes
app.get("/", async (req, res, next) => {
  try {
    const [notices, found] = await Promise.all([
      Notice.find(Notice.activeFilter())
        .populate("category")
        .sort({ isPinned: -1, publishDate: -1 })
        .limit(3),
      Item.find({ approval: "approved", type: "found", status: "found" })
        .populate("category")
        .sort({ createdAt: -1 })
        .limit(3)
    ]);
    res.render("index", { title: "Home", notices, found });
  } catch (err) {
    next(err);
  }
});
app.use("/", use("routes/auth"));
app.use("/notices", use("routes/notices"));
app.use("/items", use("routes/items"));
app.use("/display", use("routes/display"));
app.use("/admin", use("routes/admin"));

// 404
app.use((req, res) => {
  res.status(404).render("error", { title: "Not found", code: 404, message: "Page not found." });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("Server error. Check the terminal for details.");
});

// ---------- Seed: creates the admin account and default categories ----------
// Run once with:  node server.js --seed   (safe to run again)
const ADMIN = {
  name: "Admin",
  email: "admin@uni.edu",
  password: "Admin12345", // change this after the first login
  role: "admin",
  department: "Administration"
};

const CATEGORIES = [
  // Notices
  { name: "Exams", type: "notice" },
  { name: "Events", type: "notice" },
  { name: "Admissions", type: "notice" },
  { name: "Scholarships", type: "notice" },
  { name: "Sports", type: "notice" },
  { name: "Holidays", type: "notice" },
  { name: "Lost & Found", type: "notice" },
  // Lost & Found items
  { name: "ID Card", type: "item" },
  { name: "Phone", type: "item" },
  { name: "Bag", type: "item" },
  { name: "Keys", type: "item" },
  { name: "Wallet", type: "item" },
  { name: "Laptop", type: "item" },
  { name: "Books", type: "item" },
  { name: "Other", type: "item" }
];

async function runSeed() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const User = use("models/User");
    const Category = use("models/Category");

    if (await User.findOne({ email: ADMIN.email })) {
      console.log("Admin already exists:", ADMIN.email);
    } else {
      await User.create(ADMIN);
      console.log("Admin created!  Email:", ADMIN.email, " Password:", ADMIN.password);
    }
    for (const c of CATEGORIES) {
      if (await Category.findOne({ name: c.name })) console.log("Already there:", c.name);
      else { await Category.create(c); console.log("Added:", c.name, "(" + c.type + ")"); }
    }
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await mongoose.disconnect();
  }
}

// ---------- Start the server (or run the seed) ----------
if (process.argv.includes("--seed")) {
  runSeed();
} else {
  const PORT = process.env.PORT || 3000;
  mongoose
    .connect(process.env.MONGO_URI)
    .then(() => {
      console.log("MongoDB connected");
      app.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}`));
    })
    .catch((err) => {
      console.error("MongoDB connection failed:", err.message);
    });
}
