resource "azurerm_resource_group" "ai_notes" {
  name     = var.resource_group_name
  location = var.location
  tags = {
    app = "ai-notes"
  }
}

resource "azurerm_container_registry" "ai_notes" {
  name                = var.acr_name
  resource_group_name = azurerm_resource_group.ai_notes.name
  location            = azurerm_resource_group.ai_notes.location
  sku                 = "Basic"
  admin_enabled       = false
  tags = {
    app = "ai-notes"
  }
}

resource "azurerm_kubernetes_cluster" "ai_notes" {
  name                = var.cluster_name
  location            = azurerm_resource_group.ai_notes.location
  resource_group_name = azurerm_resource_group.ai_notes.name
  dns_prefix          = var.dns_prefix
  sku_tier            = "Free"
  tags = {
    app = "ai-notes"
  }

  default_node_pool {
    name       = "system"
    node_count = var.node_count
    vm_size    = var.node_vm_size
  }

  identity {
    type = "SystemAssigned"
  }
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                            = azurerm_container_registry.ai_notes.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_kubernetes_cluster.ai_notes.kubelet_identity[0].object_id
  skip_service_principal_aad_check = true
}
