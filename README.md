# MyMealChef

```
mymealchef/
  backend/    Node + Express + MongoDB API   (run everything from this folder)
  Frontend/   index.html, script.js, api.js, style.css   (served by the backend)
```

## First run
1. `cd backend && npm install`   (run it again after every update: new packages are added from time to time)
2. Copy `.env.example` to `.env` and fill it in (MONGODB_URI, JWT_SECRET, ...).
3. Create your administrator account: `npm run create-admin -- admin@example.com` (the password is entered with hidden input)
4. `npm run dev`, then open http://localhost:5000 and sign in with that email and password.

## Administrator access
Administrators use the app's regular **Login** form; there is no public admin sign-up. After login, the account's `admin` role sends it to the chef review dashboard. The admin account can schedule and record the required chef interview, then approve or reject the application.

To create another administrator, run `npm run create-admin -- another-admin@example.com` from `backend/` while `.env` points to the intended database. Use a unique email; the script prompts for the password without showing it. If that email already belongs to an account, the script asks you to type `PROMOTE` and resets that account's password as it grants admin access. Only run this command from a trusted computer with access to the intended database.

## Useful commands (in backend/)
| Command | What it does |
|---|---|
| `npm run dev` | start the server with Node's built-in file watcher |
| `npm run seed` / `npm run seed:delete` | add / remove 30 demo chefs (Kenya, Uganda, Tanzania); the first 12 Kenyan ones come with an open kitchen and a menu |
| `npm run test:flow` | end-to-end API test against your database (server must be running) |
| `npm run migrate` | one-off upgrade of data created before countries and time slots existed |
| `npm run verify-existing` | run ONCE when switching on email confirmation: marks all existing accounts as confirmed |

## How a chef goes live
Chef signs up -> completes the application (phone number, answers, passport/ID, certificate)
-> admin calls / video-interviews the chef and records the result -> admin approves.
Approval is impossible until the live interview has been passed.

## Google sign-in (optional)
The "Continue with Google" buttons only appear when `GOOGLE_CLIENT_ID` is set.
1. Google Cloud Console (console.cloud.google.com) > create or pick a project.
2. APIs & Services > OAuth consent screen: User type **External**, app name MyMealChef, your email as support/developer contact. Save.
   While the app is in **Testing**, only emails listed under "Test users" can sign in. Click **Publish app** so everyone can (basic sign-in needs no Google review).
3. APIs & Services > Credentials > Create credentials > **OAuth client ID** > Web application.
   Authorised JavaScript origins: `http://localhost`, `http://localhost:5000`, and your live site `https://chefmtaani.onrender.com`. No redirect URI is needed.
4. Copy the **Client ID** (no secret needed) into `backend/.env` as `GOOGLE_CLIENT_ID=...` and into the Render environment variables. Restart the server.

Rules: a brand-new Google sign-up becomes a customer. Anyone who already has an account with the same email enters that
account's password once to connect Google (this stops someone who registered your email first from keeping access).
Chefs still apply through the chef sign-up form; afterwards they can use Google to log in.

## Forgot password
"Forgot password?" (on both login forms) emails a link that opens the "choose a new password" page.
- Needs working email: `EMAIL_*` in `.env` (for Gmail use an App Password) and `APP_URL` set to the site's address
  (`http://localhost:5000` locally, `https://chefmtaani.onrender.com` live) so the link in the email points to the right place.
- The link works once and expires after 60 minutes. Asking again within a minute sends nothing new.
- After a reset every older login on that account is signed out.
- Accounts that signed up with Google can use the same link to add a password.
- Nobody can use the form to find out which emails have accounts: the answer is always the same.

## Email confirmation
New email-and-password sign-ups (customers and chefs) get a link by email that is valid for 24 hours.
- Until they confirm, people can log in and browse, a reminder bar with a "Resend email" button stays on screen, and:
  customers cannot book, chefs cannot submit their application.
- Google sign-ups are already confirmed. A password reset, or linking Google, also confirms the address.
- Resending is limited to one email per minute. A new link cancels the older one.
- Needs working email (`EMAIL_*` and `APP_URL` in `.env`), exactly like the password-reset email.
- **When you deploy this update, run `npm run verify-existing` once**, so accounts created before this feature are not asked to confirm.
  Demo chefs (`npm run seed`) and admins (`npm run create-admin`) are created already confirmed.

## Food ordering: chefs as independent kitchens
Besides home visits, an approved chef can run a **kitchen**: customers order meals for delivery or pickup, like a small restaurant.

**Chef** (dashboard > *Kitchen & meals* and *Orders*)
1. Add meals (name, price, category, cuisine, preparation time, diet tags). Switch a meal off when it is sold out.
2. Fill in the kitchen: name, tagline, phone, pickup address, the neighbourhoods you deliver to (empty = your whole city), pickup and/or rider delivery, and **who books the rider** (you or the customer). Then switch on "List my kitchen".
3. Orders arrive in the *Orders* tab: Accept (say when it will be ready) or Decline with a reason, then Preparing, Ready, Completed.
4. For delivery, book a rider in **Bolt, Uber, Glovo, Little** or another app and note the rider's name, phone and tracking link on the order. The customer sees it.

**Customer** (*Order Food* in the menu)
Search by city and neighbourhood, cuisine and diet, open a kitchen's menu, build a cart, choose delivery or pickup and check out.
*My Orders & Bookings > Food orders* shows status, the ready time, rider details, and the reason if an order is declined.

**Privacy**: the kitchen's phone and pickup address are never public. A customer sees them only for their own *accepted* order that needs them
(pickup, or when the customer books their own rider). The chef sees the customer's phone and street only after accepting.

**Not built in (by design for now)**
- Delivery apps are not integrated: Bolt, Uber and the others have no open ordering API. The chef or customer books the rider in that app and records the details here.
- Payment is arranged directly with the chef; the rider fee is paid to the delivery service.
- Orders do not yet have reviews or photos of meals.
