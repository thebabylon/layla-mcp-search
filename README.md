# layla-mcp-search v2

سيرفر MCP لتطبيق Layla وGoogle AI Edge: بحث ويب وأخبار، وقراءة أي صفحة عامة، وقراءة وكتابة آمنة على GitHub.

## الأدوات

| الأداة | وظيفتها |
|---|---|
| `search_code` | بحث برمجي، المصادر الرسمية (MDN, GitHub, Stack Overflow…) في الأول |
| `brave_web_search` | بحث عام، المصادر الموثوقة في الأول. خيارات: `freshness` (pd/pw/pm/py) و`site` |
| `search_news` | أخبار حديثة (الافتراضي: آخر أسبوع) |
| `read_page` | يفتح **أي صفحة عامة** ويقرا نصها. الصفحات الطويلة: بيرجّع **فهرس عناوين** بمكان كل عنوان، و`find="كلمات"` بيجيب الفقرات المطلوبة بس، و`offset` للإكمال (القص عند نهاية سطر). `links=true` لعرض الروابط. `images=true` لوصف الصور. صفحات JavaScript وPDF والصور بتتقرا عن طريق قارئ خارجي |
| `github_list_repos` / `github_list_files` / `github_read_file` / `github_search_code` | قراءة من GitHub (بتظهر لما `GITHUB_TOKEN` يكون موجود) |
| `github_write_file` / `github_open_pr` | كتابة آمنة (بتظهر لما `GITHUB_WRITE_REPOS` يكون موجود) |

**الكتابة دايماً على فرع `layla-edits`، مش `main`.** وفتح الـ Pull Request متاح، لكن الدمج بيتم يدوي من GitHub.

## المتغيرات (Environment)

| المتغير | مطلوب؟ | المعنى |
|---|---|---|
| `MCP_API_KEY` | **أيوه** | الباسورد (Bearer). السيرفر مابيشتغلش من غيره |
| `BRAVE_API_KEY` | أيوه للبحث | مفتاح Brave Search |
| `GITHUB_TOKEN` | اختياري | Fine-grained token. للقراءة: Contents **Read-only** |
| `GITHUB_ALLOWED_OWNERS` | اختياري | أصحاب الريبوهات المسموحين (الافتراضي `newmyacc13-rgb`) |
| `GITHUB_WRITE_REPOS` | اختياري | `owner/name` للريبوهات المسموح الكتابة عليها. فاضي = كتابة معطلة |
| `RESULT_REMINDER` | اختياري | تذكير قصير (حتى 600 حرف) بيتضاف آخر كل نتيجة بحث أو قراءة، علشان الموديل يشوفه قبل ما يكتب الرد |
| `JINA_FALLBACK` | اختياري | الافتراضي مفعّل. `off` = ماحدش خارجي يشوف الروابط (وبعدها JS وPDF والصور مش هتتقرا) |
| `JINA_API_KEY` | اختياري | مفتاح Jina مجاني، بيرفع الحد من 20 لـ 500 طلب في الدقيقة تقريباً |

للكتابة: التوكن يحتاج Contents **Read and write** + Pull requests **Read and write** على الريبو ده بس.

## النشر (من الموبايل)

1. **مستودع جديد:** GitHub ← New repository ← الاسم مثلاً `layla-mcp-search-v2` ← **Private**.
2. **ارفع الملفات:** Add file ← Upload files ← `index.js` و`package.json` و`README.md` ← Commit.
3. **Render:** New ← Web Service ← اختار المستودع الجديد.
   - Build: `npm install`، Start: `npm start`
   - أضف المتغيرات (أو اربط الـ Environment Group `layla-search-keys`).
4. بعد النشر افتح `https://اسم-الخدمة.onrender.com/` ← لازم تشوف `MCP server is running`.
5. **Layla:** MCP Support ← Server URL: `https://اسم-الخدمة.onrender.com/sse` ← Bearer = قيمة `MCP_API_KEY` ← Discover Tools.

لو عايز تتأكد من الأدوات المفعّلة: `GET /status` بنفس الـ Bearer بيرجّع الأدوات والميزات (من غير أي أسرار).

## اختبار الـ push (قائمة تحقق)

1. اطلب من Layla: «اعرض ريبوهاتي» ← لازم يستدعي `github_list_repos`.
2. «اقرا ملف package.json» ← `github_read_file`.
3. فعّل `GITHUB_WRITE_REPOS` على **مستودع تجارب** (مش مستودع السيرفر)، وأعد النشر.
4. «اكتب ملف notes/test.md فيه كلمة hello» ← `github_write_file`.
5. افتح GitHub ← لازم تلاقي فرع `layla-edits` وفيه الملف. ثم «افتح Pull Request» ← `github_open_pr`.
6. اعمل Merge بنفسك. وفعّل Branch protection على `main` (يطلب Pull Request) كطبقة أمان إضافية.

## الأمان

- الباسورد إجباري، ومقارنته آمنة ضد التخمين الزمني.
- `read_page` بيقبل أي موقع **عام**، وبيمنع localhost والشبكات الداخلية وعناوين السحابة (169.254…)، وبيفحص كل إعادة توجيه.
- GitHub: مقفول على `GITHUB_ALLOWED_OWNERS`، والكتابة مقفولة على قائمة صريحة، ومحظورة في `.github/`، وبحد 100KB للملف.
- **لا تفعّل الكتابة على مستودع السيرفر نفسه**: لو اتنشر كود غلط أو خبيث على `main` هيتنفذ على السيرفر اللي فيه مفاتيحك.
- ماتحطش المفاتيح في الكود أو الريبو. كلها Environment Variables.

## قراءة الصفحات والصور

- **أولاً** القراءة مباشرة من السيرفر (سريعة وخاصة). لو الصفحة طلعت شبه فاضية (موقع React/Vite…) أو الموقع حجب البوتات (403/429/503) أو الملف PDF أو صورة، بيجرّب تلقائياً **Jina Reader** (`r.jina.ai`) اللي بيشغّل المتصفح ويحوّل الصفحة لنص.
- **أخطاء زي 404** مابتروحش للقارئ الخارجي.
- **الخصوصية:** في وضع القارئ الرابط بيتبعت لـ Jina (جهة خارجية). ماتطلبش منه يفتح روابط خاصة أو فيها توكن. السيرفر بيمنع الشبكات الداخلية قبل ما يبعت أي رابط. للإيقاف: `JINA_FALLBACK=off`.
- **الصور:** `images=true` بيخلي القارئ يضيف وصفاً للصور اللي في الصفحة. وعلى رابط صورة مباشر بيحاول يوصفها، **وده الجزء الوحيد اللي ماقدرتش أتأكد منه** لأن الاختبار كان بشبكة وهمية، فجرّبه على صورة حقيقية. وللصور اللي عندك على الموبايل، أرفقها في التطبيق نفسه لو الموديل بيدعم الرؤية.
- **صفحة طويلة؟** الموديل يبدأ بـ `read_page` ويشوف الفهرس، ثم `find` أو `offset`.

## حدود معروفة

- مواقع بتطلب تسجيل دخول أو CAPTCHA قوي هتفضل ممنوعة حتى مع القارئ الخارجي.
- الخطة المجانية لـ Brave بطيئة (طلب كل ثانية تقريباً). السيرفر بيعيد المحاولة مرة واحدة.
- الأدوات كتير؟ بدون `GITHUB_TOKEN` بتظهر 4 أدوات بس، وده أنسب للموديلات اللي سياقها صغير (زي AI Edge بـ 4096).

## نص مقترح للـ System Prompt

```
Tools: search_code, brave_web_search (freshness, site), search_news, read_page (page_url, find, offset, links, images), and GitHub tools.
Use search for code questions, versions, errors, news, and facts that may have changed; answer directly for chat.
After searching, open the best source with read_page when it helps. For long pages use read_page with find="keywords" instead of reading everything. Use github_list_repos to find exact repo names.
Say what comes from sources and what is your inference. Today's date appears in search results; never dismiss results as outdated.
Reply in my language; keep code and search queries in English.
```
