# המכלול אופליין - Hamichlol Offline

אפליקציית Electron המאפשרת התקנת והרצת MediaWiki באופן מקומי ללא צורך בחיבור לאינטרנט.

## מאפיינים

- התקנה אוטומטית של שרת PHP
- התקנה אוטומטית של שרת MySQL/MariaDB
- התקנה אוטומטית של MediaWiki
- ממשק משתמש פשוט לניהול השרתים
- הרצת המערכת ללא צורך בחיבור לאינטרנט

## דרישות מערכת

- Windows 10 ומעלה
- מינימום 500MB פנויים בדיסק
- מינימום 4GB RAM

## התקנה למפתחים

1. התקן את Node.js
2. שבט (Clone) את המאגר:
```bash
git clone https://github.com/yourusername/hamichlol-offline.git
cd hamichlol-offline
```

3. התקן את התלויות:
```bash
npm install
```

4. הרץ את האפליקציה:
```bash
npm start
```

## בנייה לשימוש

```bash
npm run dist
```

הקובץ המותקן יהיה זמין בתיקיית `dist`.

## מבנה הפרויקט

```
hamichlol-offline/
├── src/                    # קוד המקור של האפליקציה
│   ├── main.js             # תהליך ראשי של Electron
│   ├── server-manager.js   # ניהול התקנה והפעלת שרתים
│   └── renderer/           # קבצי ממשק משתמש
│       └── index.html      # ממשק המשתמש הראשי
├── resources/              # משאבים עבור האפליקציה
│   ├── server/             # קבצי שרת (PHP, MySQL)
│   └── mediawiki/          # קבצי MediaWiki
├── scripts/                # סקריפטים לאוטומציה
├── package.json            # הגדרות פרויקט ותלויות
└── forge.config.js         # תצורת Electron Forge
```

## רישיון

פרויקט זה משוחרר תחת רישיון MIT.
