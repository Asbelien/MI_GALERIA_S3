import os
import re
import time
import secrets

import boto3
from botocore.client import Config
from dotenv import load_dotenv
from flask import Flask, request, jsonify
from flask_cors import CORS

load_dotenv()

REGION = os.getenv("AWS_REGION", "us-east-1")
BUCKET = os.getenv("S3_BUCKET")
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_SIZE_MB = 5

s3 = boto3.client("s3", region_name=REGION, config=Config(signature_version="s3v4"))

app = Flask(__name__)
CORS(app, origins=["http://localhost:8080", "http://127.0.0.1:8080"])


@app.post("/api/upload-url")
def upload_url():
    data = request.get_json(silent=True) or {}
    filename = data.get("filename", "")
    content_type = data.get("contentType", "")
    size_bytes = data.get("sizeBytes", 0)

    if content_type not in ALLOWED_TYPES:
        return jsonify(error="Tipo de archivo no permitido"), 400
    if not isinstance(size_bytes, int) or size_bytes <= 0 or size_bytes > MAX_SIZE_MB * 1024 * 1024:
        return jsonify(error="Archivo demasiado grande o tamaño inválido"), 400
    if not filename:
        return jsonify(error="Falta el nombre del archivo"), 400

    safe_name = re.sub(r"[^a-zA-Z0-9._-]", "_", os.path.basename(filename))
    key = f"originales/{int(time.time() * 1000)}-{secrets.token_hex(6)}-{safe_name}"

    url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": BUCKET, "Key": key, "ContentType": content_type},
        ExpiresIn=300,
    )
    return jsonify(uploadUrl=url, key=key)


@app.get("/api/images")
def list_images():
    resp = s3.list_objects_v2(Bucket=BUCKET, Prefix="originales/")
    items = []
    for obj in resp.get("Contents", []):
        if obj["Key"].endswith("/"):
            continue
        url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": BUCKET, "Key": obj["Key"]},
            ExpiresIn=900,
        )
        items.append({
            "key": obj["Key"],
            "size": obj["Size"],
            "lastModified": obj["LastModified"].isoformat(),
            "url": url,
        })
    return jsonify(items)


@app.delete("/api/images/<path:key>")
def delete_image(key):
    if not key.startswith("originales/") or ".." in key:
        return jsonify(error="Clave no válida"), 400
    s3.delete_object(Bucket=BUCKET, Key=key)
    return jsonify(deleted=True)


if __name__ == "__main__":
    app.run(port=int(os.getenv("PORT", 3000)), debug=True)