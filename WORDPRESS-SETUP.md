# WordPress Theme Setup Instructions

## Step 1: Upload Files to WordPress

All your files are already configured for WordPress. Make sure these files are in `/wp-content/themes/amy/`:

- style.css (with WordPress headers)
- functions.php (NEW - must upload this!)
- index.php
- profile.php
- leaderboard.php
- earn.php
- points.php
- contact.php
- tailwind-output.css
- All images (favicon.svg, pro.jpg, image.png)
- All JavaScript files (index.js, profile.js)

## Step 2: Activate the Theme

1. Log in to your WordPress admin panel: `https://amyonbera.com/wp-admin`
2. Go to **Appearance → Themes**
3. Find "Amy" theme and click **Activate**

## Step 3: Create Pages in WordPress

Now you need to create WordPress pages and assign templates:

1. Go to **Pages → Add New**
2. Create these pages:

### Home Page
- Title: "Home" (or leave blank)
- Template: Default (uses index.php automatically)
- Publish the page
- Go to **Settings → Reading**
- Set "Your homepage displays" to "A static page"
- Choose "Home" as the homepage

### Profile Page
- Title: "Profile"
- Permalink: Set to "profile" (click Edit next to permalink)
- Template: Select **"Profile"** from the Page Attributes → Template dropdown
- Publish

### Leaderboard Page
- Title: "Leaderboard"
- Permalink: Set to "leaderboard"
- Template: Select **"Leaderboard"**
- Publish

### Earn on Bera Page
- Title: "Earn on Bera"
- Permalink: Set to "earn"
- Template: Select **"Earn on Bera"**
- Publish

### Amy Points Page
- Title: "Amy Points"
- Permalink: Set to "points"
- Template: Select **"Amy Points"**
- Publish

### Contact Page
- Title: "Contact"
- Permalink: Set to "contact"
- Template: Select **"Contact"**
- Publish

## Step 4: Update Navigation Links

After creating the pages, you need to update the navigation links in your PHP files:

Replace:
- `href="index.php"` → `href="/"`
- `href="profile.php"` → `href="/profile"`
- `href="leaderboard.php"` → `href="/leaderboard"`
- `href="earn.php"` → `href="/earn"`
- `href="points.php"` → `href="/points"`
- `href="contact.php"` → `href="/contact"`

(Let me know if you want me to do this automatically!)

## Step 5: Clear Cache

1. If you have a caching plugin, clear the cache
2. Do a hard refresh: Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac)

## Troubleshooting

### CSS Still Not Loading?
- Check file permissions (should be 644 for files, 755 for directories)
- Clear browser cache
- Check WordPress admin → Appearance → Theme File Editor to verify files are there

### Pages Show 404?
- Go to **Settings → Permalinks** and click "Save Changes" (this refreshes the permalinks)

### Still Having Issues?
- Check browser console for errors (F12)
- Verify the theme is activated
- Make sure all files uploaded correctly to `/wp-content/themes/amy/`
