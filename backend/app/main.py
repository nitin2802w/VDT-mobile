from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes.upload import router as upload_router
from app.routes.symbol import router as symbol_router
from app.routes.download import router as download_router
from app.ws.sender_socket import router as sender_router
from app.ws.receiver_socket import router as receiver_router

app = FastAPI(
    title="Visual Data Transfer API",
    description="Fountain-coded QR-based local file transfer backend.",
    version="0.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# REST layer (Phase B2)
app.include_router(upload_router,   prefix="/api")
app.include_router(symbol_router,   prefix="/api")
app.include_router(download_router, prefix="/api")

# WebSocket realtime layer (Phase B3)
app.include_router(sender_router,   prefix="/api/ws")
app.include_router(receiver_router, prefix="/api/ws")


@app.get("/ping")
def ping():
    return {"status": "ok"}
