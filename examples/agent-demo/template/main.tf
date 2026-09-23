resource "aws_dynamodb_table" "orders" {
  name         = "orders"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_s3_bucket" "invoices" {
  bucket        = "invoices"
  force_destroy = true
}

resource "aws_sqs_queue" "order_events" {
  name = "order-events"
}
