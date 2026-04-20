# Travel Planner API

## 🚀 Key Features (Headless Edition)

- **RESTful API Architecture:** A standard, stateless API designed for easy consumption by mobile and web clients.
- **Swagger Documentation:** Built-in interactive API explorer at `/api-docs`.
- **Real-Time Collaboration:** WebSocket-based synchronization ensuring that all connected users see updates instantly.
- **Robust Travel Features:**
  - **Itinerary Management:** Daily planning with drag-and-drop support logic.
  - **Financial Tracking:** Multi-currency budget tracking and expense splitting.
  - **Logistics:** Interactive map integrations (OpenStreetMap/Google Places), reservation tracking, and document management.
  - **Checklists:** Packing lists with template support.
- **Advanced Security:**
  - **JWT Authentication:** Secure token-based access.
  - **Multi-Factor Authentication (MFA):** External TOTP support.
  - **OIDC Integration:** Single Sign-On (SSO) support for Google, Apple, and more.
- **Developer First:** Built with TypeScript 6, Node.js 22, and SQLite for maximum performance and minimum operational overhead.

## 🛠 Getting Started

### Prerequisites
- Node.js 22.x
- Docker (optional)

### Quick Start (Local)
1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/your-repo/travel-planner-api.git
    cd travel-planner-api/server
    ```
2.  **Install Dependencies:**
    ```bash
    npm install
    ```
3.  **Environment Configuration:**
    Copy `.env.example` to `.env` and set your `ENCRYPTION_KEY`.
4.  **Run in Development Mode:**
    ```bash
    npm run dev
    ```
5.  **Access Documentation:**
    Navigate to `http://localhost:3000/api-docs` to explore the API.

## 🐳 Docker Deployment
The project includes a streamlined, single-stage Dockerfile for fast deployments.

```bash
docker build -t travel-planner-api .
docker run -d -p 3000:3000 -v ./data:/app/data -v ./uploads:/app/uploads travel-planner-api
```

## 📱 Mobile Integration (Flutter)
This backend is designed to be the backbone of your Flutter application. It supports **Bearer Token** authentication out of the box, allowing you to use local storage on the device to maintain user sessions.

For real-time sync, use the `/ws-token` endpoint to get an ephemeral token before establishing a standard WebSocket connection to `/ws`.

## 📄 License
This project is licensed under the AGPL-3.0 License.
