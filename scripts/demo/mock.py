"""Private, disposable Moto server and data probe for the recording demo."""

import json
import logging
import sys

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from moto.server import ThreadedMotoServer


def reply(value):
    print(json.dumps(value), flush=True)


def main():
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    options = {
        "endpoint_url": endpoint,
        "region_name": "eu-central-1",
        "aws_access_key_id": "test",
        "aws_secret_access_key": "test",
        "config": Config(connect_timeout=3, read_timeout=10, retries={"max_attempts": 0}),
    }
    db = boto3.client("dynamodb", **options)
    s3 = boto3.client("s3", **options)
    reply({"endpoint": endpoint})
    try:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                if request["action"] == "seed":
                    items = [
                        {
                            "PutRequest": {
                                "Item": {
                                    "id": {"S": f"ord-{i}"},
                                    "customer": {"S": "Acme Corp"},
                                    "status": {"S": "paid, awaiting shipment"},
                                    "total": {"N": f"{i % 90 + 10}.99"},
                                }
                            }
                        }
                        for i in range(1001, 1026)
                    ]
                    result = db.batch_write_item(RequestItems={"orders": items})
                    if result.get("UnprocessedItems"):
                        raise RuntimeError("Some demo orders were not written")
                    for i in range(1001, 1004):
                        s3.put_object(
                            Bucket="invoices",
                            Key=f"ord-{i}.txt",
                            Body=f"Invoice ord-{i}\nAcme Corp\nPaid; retain for accounting.\n".encode(),
                        )
                    reply({"seeded": True})
                elif request["action"] == "snapshot":
                    prefix = request.get("prefix", "")
                    try:
                        rows = []
                        arguments = {"TableName": f"{prefix}orders", "ConsistentRead": True}
                        while True:
                            page = db.scan(**arguments)
                            rows.extend(page["Items"])
                            if "LastEvaluatedKey" not in page:
                                break
                            arguments["ExclusiveStartKey"] = page["LastEvaluatedKey"]
                        rows.sort(key=lambda row: row["id"]["S"])
                    except ClientError as error:
                        if error.response["Error"]["Code"] != "ResourceNotFoundException":
                            raise
                        rows = None
                    try:
                        invoices = {}
                        pages = s3.get_paginator("list_objects_v2").paginate(Bucket=f"{prefix}invoices")
                        for page in pages:
                            for obj in page.get("Contents", []):
                                body = s3.get_object(Bucket=f"{prefix}invoices", Key=obj["Key"])["Body"]
                                try:
                                    invoices[obj["Key"]] = body.read().decode()
                                finally:
                                    body.close()
                    except ClientError as error:
                        if error.response["Error"]["Code"] != "NoSuchBucket":
                            raise
                        invoices = None
                    reply({"orders": rows, "invoices": invoices})
                else:
                    raise ValueError("Unknown demo probe action")
            except Exception as error:
                reply({"error": str(error)})
    finally:
        server.stop()


if __name__ == "__main__":
    main()
