"""
RMBG-2.0 Background Removal Service

Local sidecar service that removes image backgrounds using BRIA's RMBG-2.0 model.
Runs as a FastAPI server, spawned and managed by OpenCode.

Model: briaai/RMBG-2.0 (BiRefNet architecture, ~1GB download on first run)
License: CC BY-NC 4.0 (non-commercial free, commercial requires BRIA agreement)
"""

import io
import os

import torch
import uvicorn
from fastapi import FastAPI, Request, Response
from PIL import Image
from torchvision import transforms
from transformers import AutoModelForImageSegmentation

app = FastAPI(title="RMBG-2.0 Service")

# Global model reference, loaded once at startup
model = None
device = None
transform_image = None


def load_model():
    global model, device, transform_image

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"RMBG-2.0: Loading model on {device}...")

    model = (
        AutoModelForImageSegmentation.from_pretrained(
            "briaai/RMBG-2.0", trust_remote_code=True
        )
        .eval()
        .to(device)
    )

    transform_image = transforms.Compose(
        [
            transforms.Resize((1024, 1024)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )

    print("RMBG-2.0: Model loaded successfully")


@app.on_event("startup")
async def startup():
    load_model()


@app.get("/health")
async def health():
    return {"status": "ok", "model": "rmbg-2.0", "device": str(device)}


@app.post("/remove-background")
async def remove_background(request: Request):
    image_bytes = await request.body()
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    original_size = image.size

    # Preprocess
    input_tensor = transform_image(image).unsqueeze(0).to(device)

    # Inference
    with torch.no_grad():
        preds = model(input_tensor)[-1].sigmoid().cpu()

    # Post-process: resize mask back to original dimensions
    pred = preds[0].squeeze()
    mask = transforms.ToPILImage()(pred).resize(original_size, Image.BILINEAR)

    # Apply mask as alpha channel
    image = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    image.putalpha(mask)

    # Encode result as PNG
    output = io.BytesIO()
    image.save(output, format="PNG")
    output.seek(0)

    return Response(content=output.getvalue(), media_type="image/png")


if __name__ == "__main__":
    port = int(os.environ.get("MAKABAKA_RMBG_PORT", "7860"))
    uvicorn.run(app, host="127.0.0.1", port=port)
