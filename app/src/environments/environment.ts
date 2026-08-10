export const environment = {
  production: false,
  // apiUrl: 'http://localhost:8000',
  apiUrl: 'https://tokyohouseprice-99305686342.us-central1.run.app',
  // Local-only SUUMO scraper API (run `ENABLE_SCRAPER=1 uvicorn api:app` on the Mac Studio).
  scraperApiUrl: '/api/tokyohouseprice',
  recaptcha: {
    siteKey: '6Lflq48rAAAAADuyvHaDEUdz8nk1oXzvLuEFJ3f9'
  },
  firebaseConfig: {
    apiKey: "AIzaSyAd4-nwElGxAEIYtCe-pJH_9rszfDbYUXo",
    authDomain: "tokyohouseprice.firebaseapp.com",
    projectId: "tokyohouseprice",
    storageBucket: "tokyohouseprice.firebasestorage.app",
    messagingSenderId: "3775248230",
    appId: "1:3775248230:web:e0f9837b10ca1ade893aa7",
    measurementId: "G-GBV85V31MZ"
  }
};