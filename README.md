# University Information Display System

A Web Engineering course project: a university notice board, lost & found system and campus TV display.

**Stack:** Node.js + Express, EJS (server-side HTML), Bootstrap 5, Vanilla JS, MongoDB Atlas (Mongoose), express-session + bcrypt, Multer, Chart.js.

## The whole project is 5 files
| File | What is inside |
|---|---|
| `server.js` | The entire backend: database models, login/admin guards, file upload, all routes, server start |
| `views/page.ejs` | Every page of the website (HTML). Search with Ctrl+F for `PAGE: notices/list` etc. |
| `public/style.css` | All colours and design (change the palette at the top, in `:root`) |
| `package.json` | List of packages + start commands |
| `README.md` | This file |

(`uploads/` stores uploaded photos/PDFs, `.env` holds the secrets and is never committed.)

## Run locally
```bash
npm install
```
Create a `.env` file next to `server.js`:
```
PORT=3000
MONGO_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/uids?retryWrites=true&w=majority
SESSION_SECRET=any-long-random-string
```
Then:
```bash
npm run seed      # once: creates the admin account and default categories
npm run dev       # http://localhost:3000
```
Default admin: `admin@uni.edu` / `Admin12345` (change it after the first login).

## Features
- Roles: visitor, registered user, admin
- Notices: categories, departments, PDF/image attachment, pin/urgent, publish and expiry dates
- Search, filter, sort and pagination
- Lost & Found: reports, admin approval, claim requests, status flow
- Admin dashboard: stats, charts, approvals, users
- Display Mode (`/display`): full-screen campus TV page
- Dark mode, responsive design
