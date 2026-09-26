#!/bin/bash
# Double-click on macOS (or run on Linux) to start the pricing system.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
    echo ""
    echo "  Node.js غير مثبت على هذا الجهاز."
    echo "  نزّل النسخة LTS من الصفحة التي ستفتح الآن، ثبّتها، ثم افتح هذا الملف مرة أخرى."
    open https://nodejs.org 2>/dev/null || xdg-open https://nodejs.org 2>/dev/null
    read -r -p "  اضغط Enter للإغلاق..."
    exit 1
fi

if [ ! -d node_modules ]; then
    echo "  جاري تثبيت الحزم، انتظر قليلاً..."
    npm install --no-audit --no-fund || { read -r -p "  فشل التثبيت. تحقق من الإنترنت ثم اضغط Enter..."; exit 1; }
fi

# Open the browser a few seconds after the server starts
( sleep 4; open http://localhost:3000/admin 2>/dev/null || xdg-open http://localhost:3000/admin 2>/dev/null ) &

echo "  اترك هذه النافذة مفتوحة أثناء استخدام النظام. أغلقها للإيقاف."
npm start
