FINANCE MANAGEMENT PLATFORM - BACKEND

Files included:
- Express API server
- MongoDB connection via Mongoose
- Signup and login with hashed passwords and JWT
- Transaction list/add/delete routes
- Budget list/add-or-update/delete routes

SETUP ON WINDOWS
1. Put this folder named `backend` inside your project folder: C:\FINANCE MANAGEMENT\backend
2. In VS Code, open Terminal > New Terminal and run:
   cd "C:\FINANCE MANAGEMENT\backend"
3. Create a file named `.env` by copying `.env.example` and renaming the copy to `.env`.
   Ensure Windows has not named it `.env.txt`.
4. Open `.env`. Keep these values for local MongoDB:
   PORT=5000
   FRONTEND_URL=http://localhost:5173
   MONGO_URI=mongodb://127.0.0.1:27017/finance_management
   JWT_SECRET=replace_this_with_a_long_random_secret_string
   Replace the JWT_SECRET value with a long random secret before using real accounts.
5. Make sure the MongoDB Server Windows service is running.
6. Run:
   npm install
7. Run:
   npm run dev

Expected terminal messages:
MongoDB connected successfully
Backend running at http://localhost:5000

TEST
Open http://localhost:5000/api/health in a browser. Expected JSON:
{"status":"OK","message":"Backend is working"}

API endpoints:
POST /api/auth/signup   body: {"name":"Test User","email":"test@example.com","password":"password123"}
POST /api/auth/login    body: {"email":"test@example.com","password":"password123"}
GET  /api/transactions  requires Authorization: Bearer <token>
POST /api/transactions  requires token; body: {"type":"expense","amount":250,"category":"Food","description":"Lunch","date":"2026-10-14"}
The amount may be a positive JSON number or formatted INR string (for example, "INR 1,250.50"); it is stored as a number rounded to two decimal places.
DELETE /api/transactions/:id requires token
GET  /api/budgets       requires token; optional ?month=2026-10
POST /api/budgets       requires token; body: {"category":"Food","amount":5000,"month":"2026-10"}
DELETE /api/budgets/:id requires token

IMPORTANT
- Do not delete or replace your frontend files (index.html, style.css, script.js) with this backend folder.
- This backend expects the frontend to send JSON and use the JWT token in an Authorization header for transaction/budget requests.
- Existing MongoDB data is not deleted by these files. MongoDB creates the database/collections when data is first written.
