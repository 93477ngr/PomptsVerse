# PromptsVerse AI 🚀

The World's AI Prompt Search Engine & Multiverse Marketplace. Discover, create, and share prompts across ChatGPT, Gemini, Claude, Midjourney, Flux, Ideogram, Leonardo, Sora & more.

## 🌟 Features
- **Curated Prompt Gallery**: High-performance image and text prompts with instant one-click copy.
- **Categorized by AI Engine**: Filter by ChatGPT, Midjourney, Gemini, Stable Diffusion, Claude, and more.
- **Responsive UI**: Sleek dark modern interface with fast client-side search and tag filtering.
- **Admin Dashboard**: Review submissions, track views, likes, and copies.
- **Google AdSense Ready**: Configured with `ads.txt` and verified site structures.

## 🛠️ Tech Stack
- **Frontend**: HTML5, Vanilla CSS / Tailwind, TypeScript, Vite
- **Backend / Database**: Firebase Firestore & Cloudinary
- **Hosting**: Firebase Hosting

## 💻 Run Locally

### Prerequisites
- Node.js (v18+)
- npm or bun

### Setup
1. **Clone the repository**:
   ```bash
   git clone https://github.com/93477ngr/PomptsVerse.git
   cd PomptsVerse
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Create a `.env` file in the root directory based on `.env.example`:
   ```env
   VITE_CLOUDINARY_CLOUD_NAME=your_cloud_name
   VITE_CLOUDINARY_UPLOAD_PRESET=your_preset
   ```

4. **Start the Development Server**:
   ```bash
   npm run dev
   ```

5. **Build for Production**:
   ```bash
   npm run build
   ```

6. **Deploy to Firebase Hosting**:
   ```bash
   npm run build
   npx firebase-tools deploy --only hosting
   ```
