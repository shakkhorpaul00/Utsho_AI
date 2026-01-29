
# Utsho AI - Deployment Guide

## 1. Firebase Setup (Cloud Database)
1. Go to [Firebase Console](https://console.firebase.com/).
2. Your project is already created: **Utsho-AI**.
3. In the **Rules** tab of Firestore Database, ensure you have published this (CRITICAL for Admin tools to work):
   ```firestore
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       // Allow users to manage their own data
       match /users/{userEmail}/{document=**} {
         allow read, write: if true;
       }
       // Allow Admin (Shakkhor) to see system logs
       match /system/{document=**} {
         allow read, write: if request.auth.token.email == 'shakkhorpaul50@gmail.com';
         // Allow any authenticated user to log a failure (write only)
         allow create, update: if request.auth != null;
       }
     }
   }
   ```

## 2. Cloudflare / .env Configuration
Copy and paste these exact values into your Cloudflare "Environment Variables" or a local `.env` file:

```env
FIREBASE_API_KEY=AIzaSyC1YmtUwrkRLAQhgYEU-_0luLxMFiGQ3fk
FIREBASE_AUTH_DOMAIN=utsho-ai.firebaseapp.com
FIREBASE_PROJECT_ID=utsho-ai
FIREBASE_STORAGE_BUCKET=utsho-ai.firebasestorage.app
FIREBASE_MESSAGING_SENDER_ID=929853150501
FIREBASE_APP_ID=1:929853150501:web:c0a547ee3722b39587b6cc

# IMPORTANT: This is your Google Gemini Key (comma-separate multiple keys for pool)
API_KEY=your_gemini_api_key_here
```

## 3. Local Development
1. Install dependencies: `npm install`
2. Run app: `npm run dev`
