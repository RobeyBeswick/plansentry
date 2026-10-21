resource "aws_dynamodb_table" "orders" {
  name         = "orders"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  tags = { Demo = "before" }
}

resource "aws_s3_bucket" "invoices" {
  bucket = "invoices"
  # Deliberate risk in this fixture: replacement can empty a populated bucket.
  force_destroy = true
}
