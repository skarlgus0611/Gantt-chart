/* (요청사항) 웹 푸시 알림을 받는 서비스 워커.
   사이트가 닫혀 있어도 서버(functions/ 의 예약 작업)가 보낸 마감 알림을 띄운다. */
importScripts("https://www.gstatic.com/firebasejs/13.1.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/13.1.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDUi_7v5FjyhWWeLD7gfeA92hxlTOPa7d8",
  authDomain: "gantt-chart-e06b8.firebaseapp.com",
  projectId: "gantt-chart-e06b8",
  storageBucket: "gantt-chart-e06b8.firebasestorage.app",
  messagingSenderId: "536820128634",
  appId: "1:536820128634:web:f174b11ad34e41432dd4c3"
});

/* 알림 내용은 서버가 notification 으로 보내므로 SDK 가 알아서 띄우고, 누르면 fcmOptions.link(사이트)를 연다 */
firebase.messaging();
