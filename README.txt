تشغيل المشروع:
1) افتح Terminal داخل المجلد
2) إذا لم تكن الحزم موجودة نفّذ:
   npm install
3) شغّل النظام:
   npm start
4) افتح:
   http://localhost:3000

بيانات الدخول الافتراضية:
admin
123456

أهم ما تم تضمينه:
- هوية موحدة باسم: نظام إدارة بيانات الأيتام
- خط عربي عصري وغامق
- ثيم حسب المستخدم:
  * المدير: مائل للأسود
  * الذكر: مائل للأزرق الغامق
  * الأنثى: مائل للزهري الغامق
- لوحة بيانات قابلة لإعادة الترتيب بالسحب والإفلات
- لوحة عملات مختصرة مقابل الشيكل:
  * الدولار
  * الدينار الأردني
  * USDT
  * عملة إضافية قابلة للتخصيص
- بحث عام ومتقدم
- النتائج لا تظهر إلا بعد البحث
- عرض النتائج بوضعين:
  * بطاقات
  * جدول
- تحميل تدريجي Lazy Loading للبطاقات
- تخصيص كروت النتائج لكل مستخدم
- إدارة مستخدمين وصلاحيات
- أرشفة واسترجاع
- سجل نشاط
- إحصائيات حسب الشيت
- تقرير PDF للطباعة/الحفظ
- دعم كامل لكل الشيتات الموجودة داخل ملف Excel


Firebase login note:
- This version preserves the UI and uses Firebase Email/Password login when the login field contains an email.
- Default mapped admin email: test@test.com
- You can still log in locally with username admin / 123456 if needed.
- For new users, create the same email in Firebase Authentication and set the same email in Users داخل النظام.
