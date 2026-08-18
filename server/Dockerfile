# eKYC verification server — slim ONNX image for Railway / any container host.
#
# EKYC_BACKEND=onnx runs SCRFD + ArcFace + MiniFASNet through onnxruntime, so
# this image carries no TensorFlow, PyTorch or MediaPipe and lands near 500 MB
# instead of the multi-GB the deepface backend would need. The decision engine
# and API are identical to the dev server.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    EKYC_BACKEND=onnx \
    EKYC_LOG_FORMAT=json \
    EKYC_MODELS_DIR=/app/models

WORKDIR /app

# opencv-python-headless still links libgomp; libglib is a common transitive need.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-deploy.txt .
RUN pip install --no-cache-dir -r requirements-deploy.txt

COPY app ./app
COPY scripts ./scripts
# The three ONNX weights the onnx backend loads. Alternatively, on a host with
# build-time network, drop this COPY and run `python scripts/fetch_models.py`.
COPY models/det_10g.onnx models/w600k_r50.onnx models/minifasnet_v2.onnx ./models/

EXPOSE 8000
# Railway injects $PORT; default to 8000 for a plain `docker run`.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
